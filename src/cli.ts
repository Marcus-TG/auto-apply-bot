/**
 * CLI for running stages by hand (and for cron if you'd rather not use n8n).
 *   npm run db:init         initialize the database schema
 *   npm run discover        pull new postings
 *   tsx src/cli.ts score    score discovered jobs
 *   tsx src/cli.ts tailor   tailor + queue for approval
 *   tsx src/cli.ts submit   submit approved jobs
 *   npm run pipeline        run the whole non-human loop
 */
import { config } from "./config/index.js";
import { initSchema } from "./store/db.js";
import {
  discover,
  scoreNewJobs,
  tailorScoredJobs,
  submitApproved,
  runPipeline,
} from "./orchestrator/pipeline.js";
import { sweepExpiredApprovals } from "./approval/index.js";

const baseUrl = `http://localhost:${config.env.port}`;

async function main() {
  const cmd = process.argv[2];
  initSchema();
  switch (cmd) {
    case "db:init":
      console.log("schema initialized");
      break;
    case "discover":
      console.log(JSON.stringify(await discover(), null, 2));
      break;
    case "score":
      console.log(JSON.stringify(await scoreNewJobs(), null, 2));
      break;
    case "tailor":
      console.log(JSON.stringify(await tailorScoredJobs(baseUrl), null, 2));
      break;
    case "submit":
      console.log(JSON.stringify(await submitApproved(), null, 2));
      break;
    case "sweep":
      console.log(JSON.stringify({ expired: sweepExpiredApprovals() }, null, 2));
      break;
    case "run":
      console.log(JSON.stringify(await runPipeline(baseUrl), null, 2));
      break;
    default:
      console.log("commands: db:init | discover | score | tailor | submit | sweep | run");
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
