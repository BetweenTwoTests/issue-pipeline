import { NativeConnection, Worker } from "@temporalio/worker";
import { PIPELINE_TASK_QUEUE } from "@issue-pipeline/core";
import * as activities from "@issue-pipeline/activities";
import { loadTemporalConnectionConfig } from "./env";

async function run(): Promise<void> {
  const { address, namespace } = loadTemporalConnectionConfig();

  const connection = await NativeConnection.connect({ address });
  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: PIPELINE_TASK_QUEUE,
      workflowsPath: require.resolve("./workflows"),
      activities,
    });

    console.log(
      `[worker] polling task queue "${PIPELINE_TASK_QUEUE}" on ${address} (namespace: ${namespace})`,
    );
    await worker.run();
  } finally {
    await connection.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
