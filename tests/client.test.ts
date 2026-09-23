// Checks the client against a local HTTP server: auth, URL building,
// deserialisation and what scripts/fix-generated.mjs reshapes, without an API
// key.
//
// Imported by the package's own name, so these go through the exports map and
// the built dist/ rather than the source.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, before, beforeEach, test } from "node:test";

import {
  Configuration,
  IncidentsV1Api,
  IncidentsV2Api,
  IncidentV2ModeEnum,
  IncidentV2ToJSON,
  type Middleware,
  PayReportsV2Api,
  FetchError,
  ResponseError,
  SeveritiesV1Api,
  type IncidentV2,
} from "@incident-io/sdk";

type Reply = { status: number; body: string; contentType?: string; delayMs?: number };

let seen: IncomingMessage;
let seenBody: string;
let reply: Reply;
let basePath: string;

const server = createServer((request, response) => {
  seen = request;
  seenBody = "";
  request.on("data", (chunk: Buffer) => (seenBody += chunk));
  request.on("end", () => {
    const { status, body, contentType, delayMs = 0 } = reply;
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(status, { "Content-Type": contentType ?? "application/json" });
      response.end(body);
    }, delayMs);
  });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  basePath = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  reply = { status: 200, body: JSON.stringify({ incidents: [], severities: [] }) };
});

function config(overrides: ConstructorParameters<typeof Configuration>[0] = {}) {
  return new Configuration({ basePath, accessToken: "secret-key", ...overrides });
}

function incidents(overrides?: ConstructorParameters<typeof Configuration>[0]) {
  return new IncidentsV2Api(config(overrides));
}

function replyWithIncidents(list: object[]) {
  reply = { status: 200, body: JSON.stringify({ incidents: list }) };
}

// A decoded query string, so assertions read like the API reference.
function query() {
  return decodeURIComponent(new URL(seen.url!, basePath).search.slice(1));
}

const incident = {
  id: "01ABC",
  name: "Checkout is down",
  reference: "INC-1",
  mode: "standard",
  visibility: "public",
  created_at: "2026-01-02T03:04:05Z",
  updated_at: "2026-01-02T03:04:05Z",
  last_activity_at: "2026-01-02T03:04:05Z",
  creator: {},
  custom_field_entries: [],
  incident_role_assignments: [],
  incident_status: {
    id: "01DEF",
    name: "Investigating",
    category: "live",
    rank: 1,
    created_at: "2026-01-02T03:04:05Z",
    updated_at: "2026-01-02T03:04:05Z",
  },
  slack_channel_id: "C123",
  slack_team_id: "T123",
  team_ids: [],
};

test("sends the bearer token to the right URL", async () => {
  await incidents().incidentsV2List({ page_size: 25 });

  assert.equal(seen.headers.authorization, "Bearer secret-key");
  assert.equal(seen.method, "GET");
  assert.equal(new URL(seen.url!, basePath).pathname, "/v2/incidents");
  assert.equal(query(), "page_size=25");
});

test("identifies itself in the User-Agent", async () => {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  await incidents().incidentsV2List();

  assert.equal(seen.headers["user-agent"], `incident-io-sdk-ts/${version}`);
});

test("a User-Agent in the configuration replaces ours rather than joining it", async () => {
  // Lower case on purpose: header names are case-insensitive, and a second
  // spelling alongside ours would be sent as "ours, theirs".
  await incidents({ headers: { "user-agent": "my-app/1.0.0" } }).incidentsV2List();

  assert.equal(seen.headers["user-agent"], "my-app/1.0.0");
});

test("a User-Agent set by middleware replaces ours rather than joining it", async () => {
  const middleware: Middleware = {
    async pre({ url, init }) {
      return { url, init: { ...init, headers: { ...init.headers, "user-agent": "from-middleware/1" } } };
    },
  };
  await incidents({ middleware: [middleware] }).incidentsV2List();

  assert.equal(seen.headers["user-agent"], "from-middleware/1");
});

// fix-generated.mjs pass 2a. Unfixed, per-request headers replaced every other
// header, and the request went out with no API key.
test("per-request headers are added to the others, not swapped for them", async () => {
  await incidents().incidentsV2List({}, { headers: { "X-Trace": "1" } });

  assert.equal(seen.headers["x-trace"], "1");
  assert.equal(seen.headers.authorization, "Bearer secret-key");
  assert.match(seen.headers["user-agent"]!, /^incident-io-sdk-ts\//);
});

test("per-request header names keep their spelling for middleware", async () => {
  let names: string[] = [];
  const middleware: Middleware = {
    async pre({ init }) {
      names = Object.keys(init.headers ?? {});
    },
  };
  await incidents({ middleware: [middleware] }).incidentsV2List({}, { headers: { "X-Trace": "1" } });

  assert.ok(names.includes("X-Trace"), `middleware saw ${names.join(", ")}`);
});

// An override given as a function is handed the whole request, so it can
// still take a header away.
test("request options given as a function replace the headers", async () => {
  await incidents().incidentsV2List({}, async ({ init }) => {
    const { Authorization, ...rest } = init.headers ?? {};
    return { headers: rest };
  });

  assert.equal(seen.headers.authorization, undefined);
});

test("a per-request header replaces the same header in the configuration", async () => {
  await incidents({ headers: { "X-Team": "a" } }).incidentsV2List({}, { headers: { "x-team": "b" } });

  assert.equal(seen.headers["x-team"], "b");
});

test("deserialises a response, parsing timestamps", async () => {
  replyWithIncidents([incident]);

  const result = await incidents().incidentsV2List();

  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0]!.reference, "INC-1");
  assert.ok(result.incidents[0]!.created_at instanceof Date);
  assert.equal(result.incidents[0]!.created_at.toISOString(), "2026-01-02T03:04:05.000Z");
});

test("an error status throws a ResponseError carrying the response", async () => {
  reply = { status: 404, body: JSON.stringify({ type: "not_found", status: 404 }) };

  const error = await incidents()
    .incidentsV2Show({ id: "missing" })
    .then(() => assert.fail("expected a ResponseError"), (error: unknown) => error);

  assert.ok(error instanceof ResponseError);
  assert.equal(error.response.status, 404);
  assert.deepEqual(await error.response.json(), { type: "not_found", status: 404 });
});

// The README's timeout example: an aborted request surfaces as a FetchError
// whose cause names the reason.
test("a timeout in the request options throws a FetchError naming it", async () => {
  reply = { ...reply, delayMs: 500 };

  const error = await incidents()
    .incidentsV2List({}, { signal: AbortSignal.timeout(50) })
    .then(() => assert.fail("expected a FetchError"), (error: unknown) => error);

  assert.ok(error instanceof FetchError);
  assert.equal(error.cause.name, "TimeoutError");
});

// prepare-spec.mjs change 3. Without it the template sends `one_of=A`, the
// server ignores it, and the request returns every incident.
test("filter parameters are sent nested under their name", async () => {
  await incidents().incidentsV2List({
    status: { one_of: ["A", "B"] },
    created_at: { date_range: ["2024-12-02~2024-12-08"] },
    custom_field: { ABC: { one_of: ["XYZ"] } },
  });

  assert.equal(
    query(),
    "status[one_of]=A&status[one_of]=B" +
      "&created_at[date_range]=2024-12-02~2024-12-08" +
      "&custom_field[ABC][one_of]=XYZ",
  );
});

// fix-generated.mjs pass 2c.
test("empty and undefined filter values are left out of the query", async () => {
  await incidents().incidentsV2List({
    status: { one_of: [] },
    severity: { one_of: undefined as unknown as string[] },
    mode: { one_of: ["standard"] },
  });

  assert.equal(query(), "mode[one_of]=standard");
});

test("a filter with nothing left to send adds no query string", async () => {
  let url = "";
  const middleware: Middleware = {
    async pre(context) {
      url = context.url;
    },
  };
  await incidents({ middleware: [middleware] }).incidentsV2List({ status: { one_of: [] } });

  assert.equal(new URL(url).search, "");
  assert.ok(!url.endsWith("?"), url);
});

test("array parameters repeat their name", async () => {
  await new IncidentsV1Api(config()).incidentsV1List({ status: ["declined", "live"] });

  assert.equal(query(), "status=declined&status=live");
});

// fix-generated.mjs pass 1.
test("an endpoint with no parameters still takes a parameters object", async () => {
  const api = new SeveritiesV1Api(config());

  await api.severitiesV1List();
  await api.severitiesV1List({}, { headers: { "X-Request-Source": "test" } });

  assert.equal(seen.headers["x-request-source"], "test");
  assert.equal(seen.headers.authorization, "Bearer secret-key");
});

// Checked at compile time: the parameters object rejects anything with keys,
// so request options passed in first place are a type error rather than
// silently ignored. tsc fails this file if the directive stops being needed.
test("request options passed as the parameters object do not compile", () => {
  const api = new SeveritiesV1Api(config());
  // @ts-expect-error: `signal` belongs in the second argument.
  const call = () => api.severitiesV1List({ signal: AbortSignal.timeout(1000) });
  assert.equal(typeof call, "function");
});

// The generator's enum FromJSON is a plain cast, so a value added to the API
// after this build passes through instead of failing the whole response. The
// template-drift make target watches the template this relies on.
test("an unknown enum value is kept, and written back unchanged", async () => {
  replyWithIncidents([{ ...incident, mode: "brand_new_mode" }]);

  const result = await incidents().incidentsV2List();
  const mode: string = result.incidents[0]!.mode;

  assert.equal(mode, "brand_new_mode");
  assert.equal(IncidentV2ToJSON(result.incidents[0]!).mode, "brand_new_mode");
});

test("known enum values compare against the exported constants", async () => {
  replyWithIncidents([incident]);

  const result = await incidents().incidentsV2List();
  const first: IncidentV2 = result.incidents[0]!;

  assert.equal(first.mode, IncidentV2ModeEnum.Standard);
});

test("request bodies go under `body`", async () => {
  reply = { status: 201, body: JSON.stringify({ incident }) };

  await incidents().incidentsV2Create({
    body: { idempotency_key: "key-1", visibility: "public", name: "Checkout is down" },
  });

  assert.equal(seen.method, "POST");
  assert.equal(seen.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seenBody), {
    idempotency_key: "key-1",
    visibility: "public",
    name: "Checkout is down",
  });
});

test("the pay report download returns the file's bytes", async () => {
  reply = { status: 200, body: "name,hours\nalice,3\n", contentType: "text/csv" };

  const file = await new PayReportsV2Api(config()).payReportsV2Download({ id: "01ABC" });

  assert.equal(await file.text(), "name,hours\nalice,3\n");
});

test("require() gets the same client as import", () => {
  const required = createRequire(import.meta.url)("@incident-io/sdk");

  assert.equal(typeof required.IncidentsV2Api, "function");
  assert.equal(required.IncidentV2ModeEnum.Standard, "standard");
});
