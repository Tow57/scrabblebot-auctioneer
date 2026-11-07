// Start a native JS worker first, then explicitly install tsx in that worker.
// This avoids relying on TypeScript loader hooks inherited from the parent.
import { tsImport } from "tsx/esm/api";
await tsImport("./strategy-worker.ts", import.meta.url);
