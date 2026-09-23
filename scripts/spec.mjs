// Schema helpers shared by prepare-spec.mjs and fix-generated.mjs. They must
// walk operations identically: fix-generated.mjs derives its expected match
// counts from the operations prepare-spec.mjs hands the generator.

import { readFileSync } from "node:fs";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

export function loadSpec(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Every operation, with path-level parameters merged into its own. The
// returned objects are the schema's own, so changes to them persist.
export function operations(spec) {
  const ops = [];
  for (const pathItem of Object.values(spec.paths)) {
    for (const method of METHODS) {
      const op = pathItem[method];
      if (op) ops.push({ op, parameters: [...(pathItem.parameters ?? []), ...(op.parameters ?? [])] });
    }
  }
  return ops;
}
