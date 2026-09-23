#!/usr/bin/env node
// Writes the copy of the schema the generator reads. The committed
// openapi.json is left untouched, because that is the copy the release diffs
// against.
//
// Three changes:
//
// 1. `info.description` is emptied. The generator copies it into a header
//    comment on every file it writes, and ours is the whole API introduction,
//    about 9KB. Across ~1,200 files that was two thirds of the source, and all
//    of it would ship in the package twice over (ESM and CJS).
//
// 2. Every request body is named `body`. The generator otherwise names the
//    parameter after the payload's schema, so creating an incident reads
//    `{ IncidentsCreatePayloadV2: {...} }`, and renaming that component
//    upstream, which changes nothing on the wire, would rename the key every
//    caller writes. `x-codegen-request-body-name` is the generator's own
//    extension for this. No operation has a parameter called `body`, and
//    this fails if one ever does.
//
// 3. Object-valued query parameters are marked `explode: false`. List
//    endpoints take filters like `status`, which the API reads as
//    `status[one_of]=X`. For an exploded object the typescript-fetch template
//    spreads the object's keys into the query, sending `one_of=X`, so the
//    filter is dropped and the endpoint returns everything, whatever `style`
//    the schema declares. Unexploded, it assigns the object whole, and the
//    runtime's querystring() nests the keys in brackets, which is the format
//    the API reads.
//
// Usage: prepare-spec.mjs <openapi.json> <out.json>

import { writeFileSync } from "node:fs";
import { loadSpec, operations } from "./spec.mjs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: prepare-spec.mjs <openapi.json> <out.json>");
  process.exit(2);
}

const spec = loadSpec(input);

spec.info.description = "";

for (const { op, parameters } of operations(spec)) {
  for (const parameter of parameters) {
    if (parameter.in === "query" && parameter.schema?.type === "object") parameter.explode = false;
  }

  if (!op.requestBody) continue;
  if (parameters.some((parameter) => parameter.name === "body")) {
    console.error(`${op.operationId} has a parameter called "body", which its request body would collide with`);
    process.exit(1);
  }
  op["x-codegen-request-body-name"] = "body";
}

writeFileSync(output, JSON.stringify(spec));
