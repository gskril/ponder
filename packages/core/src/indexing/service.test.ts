import { buildSchema as buildGraphqlSchema } from "graphql";
import { beforeEach, expect, test, vi } from "vitest";

import { usdcContractConfig } from "@/_test/constants";
import { setupEventStore, setupUserStore } from "@/_test/setup";
import { publicClient } from "@/_test/utils";
import type { IndexingFunctions } from "@/build/functions";
import { schemaHeader } from "@/build/schema";
import { LogEventMetadata } from "@/config/abi";
import { Source } from "@/config/sources";
import { EventAggregatorService } from "@/event-aggregator/service";
import { buildSchema } from "@/schema/schema";

import { IndexingService } from "./service";

beforeEach((context) => setupEventStore(context));
beforeEach((context) => setupUserStore(context));

const network = {
  name: "mainnet",
  chainId: 1,
  client: publicClient,
  pollingInterval: 1_000,
  defaultMaxBlockRange: 3,
  finalityBlockCount: 10,
  maxRpcRequestConcurrency: 10,
};

const sources: Source[] = [
  {
    name: "USDC",
    ...usdcContractConfig,
    network: network.name,
    criteria: { address: usdcContractConfig.address },
    startBlock: 16369950,
    type: "logFilter",
  },
];

// const contracts = [{ name: "USDC", ...usdcContractConfig, network }];

const schema = buildSchema(
  buildGraphqlSchema(`${schemaHeader}
    type TransferEvent @entity {
      id: String!
      timestamp: Int!
    }
  `)
);

const transferIndexingFunction = vi.fn(async ({ event, context }) => {
  await context.entities.TransferEvent.create({
    id: event.log.id,
    data: {
      timestamp: Number(event.block.timestamp),
    },
  });
});

const transferEventMetadata = usdcContractConfig.events[
  "Transfer"
] as LogEventMetadata;

const indexingFunctions: IndexingFunctions = {
  _meta_: {},
  eventSources: {
    USDC: {
      bySelector: {
        [transferEventMetadata.selector]: transferEventMetadata,
      },
      bySafeName: {
        ["Transfer"]: {
          ...transferEventMetadata,
          fn: transferIndexingFunction,
        },
      },
    },
  },
};

const getEvents = vi.fn(async function* getEvents({
  // fromTimestamp,
  toTimestamp,
}) {
  yield {
    events: [
      {
        eventSourceName: "USDC",
        eventName: "Transfer",
        params: { from: "0x0", to: "0x1", amount: 100n },
        log: { id: String(toTimestamp) },
        block: { timestamp: BigInt(toTimestamp) },
        transaction: {},
      },
    ],
    metadata: {
      pageEndsAtTimestamp: toTimestamp,
      counts: [
        {
          eventSourceName: "USDC",
          selector: transferEventMetadata.selector,
          count: 5,
        },
      ],
    },
  };
});

const eventAggregatorService = {
  getEvents,
  checkpoint: 0,
} as unknown as EventAggregatorService;

beforeEach(() => {
  // Restore getEvents to the initial implementation.
  vi.restoreAllMocks();
  eventAggregatorService.checkpoint = 0;
});

test("processEvents() calls getEvents with sequential timestamp ranges", async (context) => {
  const { common, eventStore, userStore } = context;

  const service = new IndexingService({
    common,
    eventStore,
    userStore,
    eventAggregatorService,
    sources,
  });

  await service.reset({ schema, indexingFunctions });

  expect(getEvents).not.toHaveBeenCalled();

  eventAggregatorService.checkpoint = 10;
  await service.processEvents();

  expect(getEvents).toHaveBeenLastCalledWith(
    expect.objectContaining({
      fromTimestamp: 0,
      toTimestamp: 10,
    })
  );

  eventAggregatorService.checkpoint = 50;
  await service.processEvents();

  expect(getEvents).toHaveBeenLastCalledWith(
    expect.objectContaining({
      fromTimestamp: 11,
      toTimestamp: 50,
    })
  );

  service.kill();
});

test("processEvents() calls indexing functions with correct arguments", async (context) => {
  const { common, eventStore, userStore } = context;

  const service = new IndexingService({
    common,
    eventStore,
    userStore,
    eventAggregatorService,
    sources,
  });

  await service.reset({ schema, indexingFunctions });

  eventAggregatorService.checkpoint = 10;
  await service.processEvents();

  expect(transferIndexingFunction).toHaveBeenCalledWith(
    expect.objectContaining({
      event: {
        eventSourceName: "USDC",
        eventName: "Transfer",
        params: { from: "0x0", to: "0x1", amount: 100n },
        log: { id: "10" },
        block: { timestamp: 10n },
        transaction: {},
        name: "Transfer",
      },
      context: {
        contracts: {},
        entities: { TransferEvent: expect.anything() },
      },
    })
  );

  service.kill();
});

test("processEvents() model methods insert data into the user store", async (context) => {
  const { common, eventStore, userStore } = context;

  const service = new IndexingService({
    common,
    eventStore,
    userStore,
    eventAggregatorService,
    sources,
  });

  await service.reset({ schema, indexingFunctions });

  eventAggregatorService.checkpoint = 10;
  await service.processEvents();

  const transferEvents = await userStore.findMany({
    modelName: "TransferEvent",
  });
  expect(transferEvents.length).toBe(1);

  service.kill();
});

test("processEvents() updates event count metrics", async (context) => {
  const { common, eventStore, userStore } = context;

  const service = new IndexingService({
    common,
    eventStore,
    userStore,
    eventAggregatorService,
    sources,
  });

  await service.reset({ schema, indexingFunctions });

  eventAggregatorService.checkpoint = 10;
  await service.processEvents();

  const matchedEventsMetric = (
    await common.metrics.ponder_indexing_matched_events.get()
  ).values;
  expect(matchedEventsMetric).toMatchObject([
    { labels: { eventName: "setup" }, value: 1 },
    { labels: { eventName: "USDC:Transfer" }, value: 5 },
  ]);

  const handledEventsMetric = (
    await common.metrics.ponder_indexing_handled_events.get()
  ).values;
  expect(handledEventsMetric).toMatchObject([
    { labels: { eventName: "USDC:Transfer" }, value: 5 },
  ]);

  const processedEventsMetric = (
    await common.metrics.ponder_indexing_processed_events.get()
  ).values;
  expect(processedEventsMetric).toMatchObject([
    { labels: { eventName: "USDC:Transfer" }, value: 1 },
  ]);

  service.kill();
});

test("reset() reloads the user store", async (context) => {
  const { common, eventStore, userStore } = context;

  const service = new IndexingService({
    common,
    eventStore,
    userStore,
    eventAggregatorService,
    sources,
  });

  await service.reset({ schema, indexingFunctions });

  eventAggregatorService.checkpoint = 10;
  await service.processEvents();

  const transferEvents = await userStore.findMany({
    modelName: "TransferEvent",
  });
  expect(transferEvents.length).toBe(1);

  const versionIdBeforeReset = userStore.versionId;

  await service.reset({ schema, indexingFunctions });

  expect(userStore.versionId).not.toBe(versionIdBeforeReset);

  const transferEventsAfterReset = await userStore.findMany({
    modelName: "TransferEvent",
  });
  expect(transferEventsAfterReset.length).toBe(0);

  service.kill();
});

test("handleReorg() updates ponder_handlers_latest_processed_timestamp metric", async (context) => {
  const { common, eventStore, userStore } = context;

  const service = new IndexingService({
    common,
    eventStore,
    userStore,
    eventAggregatorService,
    sources,
  });

  await service.reset({ schema, indexingFunctions });

  eventAggregatorService.checkpoint = 10;
  await service.processEvents();

  const latestProcessedTimestampMetric = (
    await common.metrics.ponder_indexing_latest_processed_timestamp.get()
  ).values[0].value;
  expect(latestProcessedTimestampMetric).toBe(10);

  await service.reset({ schema, indexingFunctions });

  const latestProcessedTimestampMetricAfterReset = (
    await common.metrics.ponder_indexing_latest_processed_timestamp.get()
  ).values[0].value;
  expect(latestProcessedTimestampMetricAfterReset).toBe(0);

  service.kill();
});

test("handleReorg() reverts the user store", async (context) => {
  const { common, eventStore, userStore } = context;

  const service = new IndexingService({
    common,
    eventStore,
    userStore,
    eventAggregatorService,
    sources,
  });

  const userStoreRevertSpy = vi.spyOn(userStore, "revert");

  await service.reset({ schema, indexingFunctions });

  eventAggregatorService.checkpoint = 10;
  await service.processEvents();

  await service.handleReorg({ commonAncestorTimestamp: 6 });

  expect(userStoreRevertSpy).toHaveBeenLastCalledWith({ safeTimestamp: 6 });

  service.kill();
});

test("handleReorg() does nothing if there is a user error", async (context) => {
  const { common, eventStore, userStore } = context;

  const service = new IndexingService({
    common,
    eventStore,
    userStore,
    eventAggregatorService,
    sources,
  });

  const userStoreRevertSpy = vi.spyOn(userStore, "revert");

  await service.reset({ schema, indexingFunctions });

  transferIndexingFunction.mockImplementationOnce(() => {
    throw new Error("User error!");
  });

  eventAggregatorService.checkpoint = 10;
  await service.processEvents();

  await service.handleReorg({ commonAncestorTimestamp: 6 });

  expect(userStoreRevertSpy).not.toHaveBeenCalled();

  service.kill();
});

test("handleReorg() processes the correct range of events after a reorg", async (context) => {
  const { common, eventStore, userStore } = context;

  const service = new IndexingService({
    common,
    eventStore,
    userStore,
    eventAggregatorService,
    sources,
  });

  await service.reset({ schema, indexingFunctions });

  eventAggregatorService.checkpoint = 10;
  await service.processEvents();

  expect(getEvents).toHaveBeenLastCalledWith(
    expect.objectContaining({
      fromTimestamp: 0,
      toTimestamp: 10,
    })
  );

  // This simulates a scenario where there was a reorg back to 6
  // and the new latest block is 9.
  eventAggregatorService.checkpoint = 9;
  await service.handleReorg({ commonAncestorTimestamp: 6 });
  await service.processEvents();

  expect(getEvents).toHaveBeenLastCalledWith(
    expect.objectContaining({
      fromTimestamp: 7,
      toTimestamp: 9,
    })
  );

  service.kill();
});

test("handleReorg() updates ponder_handlers_latest_processed_timestamp metric", async (context) => {
  const { common, eventStore, userStore } = context;

  const service = new IndexingService({
    common,
    eventStore,
    userStore,
    eventAggregatorService,
    sources,
  });

  await service.reset({ schema, indexingFunctions });

  eventAggregatorService.checkpoint = 10;
  await service.processEvents();

  const latestProcessedTimestampMetric = (
    await common.metrics.ponder_indexing_latest_processed_timestamp.get()
  ).values[0].value;
  expect(latestProcessedTimestampMetric).toBe(10);

  // This simulates a scenario where there was a reorg back to 6
  // and the new latest block is 9.
  eventAggregatorService.checkpoint = 9;
  await service.handleReorg({ commonAncestorTimestamp: 6 });

  const latestProcessedTimestampMetricAfterReorg = (
    await common.metrics.ponder_indexing_latest_processed_timestamp.get()
  ).values[0].value;
  expect(latestProcessedTimestampMetricAfterReorg).toBe(6);

  service.kill();
});
