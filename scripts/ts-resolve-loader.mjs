// Registers the resolver hook above in the main thread.
import { register } from "node:module";
register("./ts-resolve.mjs", import.meta.url);
