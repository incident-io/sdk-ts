#!/usr/bin/env node
// Reshape the generated client where an additive API change would otherwise
// break callers, and check what the generator must keep getting right.
//
// Every rewrite names the exact text it replaces and must match exactly once,
// against counts taken from the schema, so an upstream template change shows
// up as a failed release rather than a silently skipped fix. A
// post-generation pass rather than a forked template for the reason
// sdk-rust gives: openapi-generator renders a fork that no longer matches its
// variables without complaint, and ignores a fork of a file it has renamed.
// The template-drift make target covers that second case.
//
// 1. Endpoints that take no parameters get an empty parameters object, so
//    every endpoint is `method(requestParameters, initOverrides?)`. The
//    generator emits `method(initOverrides?)` for these, and its first
//    optional parameter would move initOverrides to second place: a caller
//    passing request options breaks on what the API calls an additive change.
//    Adding the argument later is itself breaking, so this is day-one or
//    never.
//
//    The empty interface carries a `never` index signature. An empty
//    interface would accept any object, so `method({ signal })`, meant as
//    request options, would compile and silently do nothing.
//
// 2. runtime.ts, three fixes to how a request is built:
//
//    a. Headers passed per request as an object are merged into the others.
//       The template spreads the request options over its own, so
//       `{ headers }` replaced every header, Authorization included, and the
//       request went out unauthenticated. An override given as a function is
//       handed the full request and still replaces the headers wholesale, so
//       it remains the way to remove one.
//
//    b. The User-Agent names this SDK and its version. Without it Node sends
//       `node`, and incident.io cannot tell an SDK caller from any other
//       fetch. It is added after middleware runs, and only when no
//       User-Agent is set in any casing, so the caller's always wins and is
//       never joined with ours.
//
//    c. Query values that are undefined, null or an empty array are left
//       out. The template sent them as `status[one_of]=undefined` or
//       `status=`, which filters on that string instead of not filtering. The
//       `?` is only added when something is left to send.
//
// It also asserts two things done elsewhere or by the generator, so that a
// future version that stops fails the release: that no filter parameter has
// its keys spread into the query (see prepare-spec.mjs), and that every
// operation the schema marks deprecated carries `@deprecated`.
//
// Report anything fixed here upstream, and delete it when it lands.
//
// Usage: fix-generated.mjs <src-dir> <openapi.json>

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSpec, operations } from "./spec.mjs";

const [srcDir, specPath] = process.argv.slice(2);
if (!srcDir || !specPath) {
  console.error("usage: fix-generated.mjs <src-dir> <openapi.json>");
  process.exit(2);
}

const ops = operations(loadSpec(specPath));
const apisDir = join(srcDir, "apis");
const apiFiles = readdirSync(apisDir)
  .filter((name) => name.endsWith(".ts") && name !== "index.ts")
  .map((name) => join(apisDir, name));

const failures = [];

// Apply each [from, to] pair to `text`, requiring every `from` to appear
// exactly once.
function replaceEach(text, pairs, where) {
  for (const [from, to] of pairs) {
    const first = text.indexOf(from);
    if (first === -1 || text.indexOf(from, first + 1) !== -1) {
      failures.push(`${where}: expected exactly one match for ${JSON.stringify(from)}`);
      continue;
    }
    text = text.slice(0, first) + to + text.slice(first + from.length);
  }
  return text;
}

function expectCount(name, got, want) {
  if (got === want) {
    console.log(`Fixed: ${name} (${got})`);
  } else {
    failures.push(`${name}: matched ${got}, expected ${want}`);
  }
}

// 1. Parameterless endpoints.
function fixParameterlessEndpoints() {
  const want = ops.filter(({ op, parameters }) => parameters.length === 0 && !op.requestBody).length;

  const INIT = "initOverrides?: RequestInit | runtime.InitOverrideFunction";
  const CLASS = /\/\*\*\n(?: \*.*\n)* \*\/\nexport class \w+ extends runtime\.BaseAPI \{/;
  const OPTS = /async (\w+)RequestOpts\(\): Promise<runtime\.RequestOpts> \{/g;

  let got = 0;
  for (const file of apiFiles) {
    let source = readFileSync(file, "utf8");
    const names = [...source.matchAll(OPTS)].map((match) => match[1]);
    if (names.length === 0) continue;

    const interfaces = [];
    for (const op of names) {
      const iface = `${op[0].toUpperCase()}${op.slice(1)}Request`;
      if (source.includes(`export interface ${iface} `)) {
        failures.push(`${file} ${op}: ${iface} already exists`);
        continue;
      }
      source = replaceEach(
        source,
        [
          [`async ${op}RequestOpts(): Promise<runtime.RequestOpts> {`, `async ${op}RequestOpts(requestParameters: ${iface}): Promise<runtime.RequestOpts> {`],
          [`await this.${op}RequestOpts();`, `await this.${op}RequestOpts(requestParameters);`],
          [`async ${op}Raw(${INIT})`, `async ${op}Raw(requestParameters: ${iface}, ${INIT})`],
          [`async ${op}(${INIT})`, `async ${op}(requestParameters: ${iface} = {}, ${INIT})`],
          [`this.${op}Raw(initOverrides)`, `this.${op}Raw(requestParameters, initOverrides)`],
        ],
        `${file} ${op}`,
      );
      interfaces.push(
        `/**\n * ${op} takes no parameters yet. The argument exists so that the first\n * one the API adds is a new optional field here, not a change to the\n * method's signature. Pass request options as the second argument.\n */\nexport interface ${iface} {\n    [key: string]: never;\n}\n\n`,
      );
      got++;
    }

    const next = source.replace(CLASS, (match) => interfaces.join("") + match);
    if (next === source) failures.push(`${file}: no API class to insert parameter interfaces before`);
    writeFileSync(file, next);
  }
  expectCount("parameterless endpoints take a parameters object", got, want);
}

// 2. runtime.ts.
function fixRuntime() {
  const file = join(srcDir, "runtime.ts");
  const BASE_PATH = 'export const BASE_PATH = "https://api.incident.io".replace(/\\/+$/, "");\n';
  const QUERY_KEY = "    const fullKey = keyPrefix + (keyPrefix.length ? `[${key}]` : key);\n";

  const before = failures.length;
  const source = replaceEach(
    readFileSync(file, "utf8"),
    [
      [
        BASE_PATH,
        BASE_PATH +
          "\n" +
          "import { VERSION } from './version.js';\n" +
          "\n" +
          "// Set by scripts/fix-generated.mjs, so incident.io can see which SDK and\n" +
          "// version a request came from.\n" +
          "const USER_AGENT = `incident-io-sdk-ts/${VERSION}`;\n",
      ],
      [
        "        const overriddenInit: RequestInit = {\n" +
          "            ...initParams,\n" +
          "            ...(await initOverrideFn({\n" +
          "                init: initParams,\n" +
          "                context,\n" +
          "            }))\n" +
          "        };\n",
        "        const overrides = await initOverrideFn({\n" +
          "            init: initParams,\n" +
          "            context,\n" +
          "        });\n" +
          "        const overriddenInit: RequestInit = {\n" +
          "            ...initParams,\n" +
          "            ...overrides,\n" +
          "            // An object's headers are merged into ours: see mergeHeaders. A\n" +
          "            // function was handed the full request, so what it returns stands.\n" +
          "            headers: typeof initOverrides === 'function'\n" +
          "                ? (overrides?.headers ?? initParams.headers)\n" +
          "                : mergeHeaders(initParams.headers, overrides?.headers),\n" +
          "        };\n",
      ],
      [
        "            response = await (this.configuration.fetchApi || fetch)(fetchParams.url, fetchParams.init);\n",
        "            fetchParams = { ...fetchParams, init: { ...fetchParams.init, headers: withUserAgent(fetchParams.init.headers) } };\n" +
          "            response = await (this.configuration.fetchApi || fetch)(fetchParams.url, fetchParams.init);\n",
      ],
      [
        "            url += '?' + this.configuration.queryParamsStringify(context.query);\n",
        "            const queryString = this.configuration.queryParamsStringify(context.query);\n" +
          "            if (queryString) {\n" +
          "                url += '?' + queryString;\n" +
          "            }\n",
      ],
      [
        QUERY_KEY,
        QUERY_KEY +
          "    // Added by scripts/fix-generated.mjs: nothing to send is not a value to\n" +
          "    // filter on.\n" +
          "    if (value === undefined || value === null || (value instanceof Array && value.length === 0)) {\n" +
          "        return '';\n" +
          "    }\n",
      ],
    ],
    file,
  );
  writeFileSync(
    file,
    source +
      `
// Added by scripts/fix-generated.mjs. Per-request headers override the
// configuration's and the operation's one by one, case-insensitively, rather
// than replacing them all. Names keep the spelling they were given, so
// middleware reading \`init.headers\` finds them where it set them.
function mergeHeaders(base: HTTPHeaders, override: HeadersInit | undefined): HTTPHeaders {
    const merged: HTTPHeaders = { ...base };
    if (override === undefined) {
        return merged;
    }
    const entries: Array<[string, string]> = override instanceof Headers || Array.isArray(override)
        ? [...new Headers(override).entries()]
        : Object.entries(override);
    for (const [name, value] of entries) {
        for (const key of Object.keys(merged)) {
            if (key.toLowerCase() === name.toLowerCase()) {
                delete merged[key];
            }
        }
        merged[name] = value;
    }
    return merged;
}

// Added by scripts/fix-generated.mjs. Keeps the shape the headers arrived in,
// so middleware sees what it set.
function withUserAgent(headers: HeadersInit | undefined): HeadersInit {
    if (new Headers(headers).has('user-agent')) {
        return headers!;
    }
    if (headers instanceof Headers) {
        const copy = new Headers(headers);
        copy.set('User-Agent', USER_AGENT);
        return copy;
    }
    if (Array.isArray(headers)) {
        return [...headers, ['User-Agent', USER_AGENT]];
    }
    return { ...headers, 'User-Agent': USER_AGENT };
}
`,
  );
  if (failures.length === before) console.log("Fixed: runtime merges headers, adds the User-Agent, skips empty query values");
}

// Filter parameters: assert, don't fix. prepare-spec.mjs marks them
// unexploded so the template assigns them whole; a spread left here means the
// template changed how it reads `explode`, and the filters are dropped again.
function checkFilterParams() {
  const spread = apiFiles.filter((file) => readFileSync(file, "utf8").includes("queryParameters[key]"));
  if (spread.length) {
    failures.push(`filter parameters are spread into the query again in ${spread.join(", ")}`);
  } else {
    console.log("Checked: no filter parameter is spread into the query");
  }
}

// The generator's name for an operation: "API Keys V1#List" becomes
// "aPIKeysV1List". Only the first character is lowered, which is where the
// odd acronym casing comes from.
function methodName(operationId) {
  const pascal = operationId
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  return pascal[0].toLowerCase() + pascal.slice(1);
}

// Deprecation markers: assert, don't fix.
function checkDeprecated() {
  const want = new Set(ops.filter(({ op }) => op.deprecated).map(({ op }) => methodName(op.operationId)));

  const marked = new Set();
  const DEPRECATED = /@deprecated\n\s*\*\/\n\s*async (\w+)\(/g;
  for (const file of apiFiles) {
    for (const [, name] of readFileSync(file, "utf8").matchAll(DEPRECATED)) {
      if (!name.endsWith("Raw") && !name.endsWith("RequestOpts")) marked.add(name);
    }
  }

  const missing = [...want].filter((name) => !marked.has(name));
  const extra = [...marked].filter((name) => !want.has(name));
  if (missing.length || extra.length) {
    failures.push(
      `deprecation markers disagree with the schema: missing ${missing.join(", ") || "none"}; ` +
        `unexpected ${extra.join(", ") || "none"}`,
    );
  } else {
    console.log(`Checked: ${want.size} deprecated operations carry @deprecated`);
  }
}

fixParameterlessEndpoints();
fixRuntime();
checkFilterParams();
checkDeprecated();

if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "\nThe generator's output no longer matches what this script was written" +
      " against. Check whether openapi-generator (pinned in the Makefile) changed" +
      " its templates, or fixed one of these upstream, in which case delete the" +
      " pass.",
  );
  process.exit(1);
}
