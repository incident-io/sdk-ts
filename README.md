# incident.io TypeScript SDK

[![npm](https://img.shields.io/npm/v/@incident-io/sdk)](https://www.npmjs.com/package/@incident-io/sdk)

The official TypeScript and JavaScript client for the
[incident.io](https://incident.io) [public API](https://api-docs.incident.io/).

It is generated automatically from our published OpenAPI schema, so it always
tracks the live API. There is a method for every endpoint, and a type for every
request and response.

## Install

```bash
npm install @incident-io/sdk
```

Requires Node 20 or later, or any runtime with a global `fetch`, and
TypeScript 5.0 or later if you use TypeScript. There are no runtime
dependencies. The package ships both ES modules and CommonJS, so `import` and
`require` both work.

Node 20 reached end of life in April 2026. It still works, but we recommend
Node 22 or 24.

The SDK is for server-side code. An API key in a browser is readable by
anyone who loads the page, and the API does not send the CORS headers a
browser would need to call it directly.

## Quickstart

Create an API key in your incident.io dashboard under **Settings → API keys**,
then:

```ts
import { Configuration, IncidentsV2Api } from "@incident-io/sdk";

const config = new Configuration({ accessToken: "my-api-key" });
const incidents = new IncidentsV2Api(config);

const result = await incidents.incidentsV2List({ page_size: 25 });
for (const incident of result.incidents) {
  console.log(incident.reference, incident.name);
}
```

Each method takes one object holding the endpoint's parameters, and an
optional second argument of request options: the `RequestInit` that `fetch`
takes, such as `headers` or `signal`. Field and parameter names are the API's
own, in snake_case, so they match the [API reference](https://api-docs.incident.io/).

## Finding an endpoint

Endpoints are grouped into one class per API resource and version, all built
from the same `Configuration`. An endpoint the API reference lists as
**Incidents V2 › List** is `incidentsV2List` on `IncidentsV2Api`; **Alert
Routes V2 › Create** is `alertRoutesV2Create` on `AlertRoutesV2Api`. Your
editor's completion on the class lists the rest.

One naming quirk comes from the generator: an acronym at the start of a name
is split. The API keys methods are `aPIKeysV1List`, `aPIKeysV1Create` and so
on, on `APIKeysV1Api`, and the IP allowlist ones are `iPAllowlistsV1...` on
`IPAllowlistsV1Api`. The class name is the searchable one.

## Request bodies

A request body goes under `body`:

```ts
const created = await incidents.incidentsV2Create({
  body: {
    idempotency_key: "a-unique-key",
    visibility: "public",
    name: "Checkout is down",
  },
});
console.log(created.incident.reference);
```

Every method also has a `...Raw` variant, for when you need the status code or
headers. It returns the `Response` as `raw`, and the parsed body from
`value()`:

```ts
const response = await incidents.incidentsV2ListRaw({ page_size: 25 });
console.log(response.raw.headers.get("X-RateLimit-Remaining"));
const page = await response.value();
```

## Filtering

List endpoints take filters as nested objects, which are sent as
`status[one_of]=...` in the query string:

```ts
const live = await incidents.incidentsV2List({
  status_category: { one_of: ["live"] },
  created_at: { gte: ["2026-01-01"] },
  custom_field: { "01ABC...": { one_of: ["01XYZ..."] } },
});
```

Each list endpoint's entry in the [API reference](https://api-docs.incident.io/)
describes its filters and operators.

## Pagination

List endpoints are cursor-paginated. Read the next cursor from
`pagination_meta.after` and pass it back:

```ts
let after: string | undefined;
do {
  const page = await incidents.incidentsV2List({ page_size: 100, after });
  for (const incident of page.incidents) {
    console.log(incident.reference, incident.name);
  }
  after = page.pagination_meta?.after;
} while (after);
```

## Errors

A response with a non-2xx status throws a `ResponseError`, which carries the
`Response`. The body is the API's standard error format, and
`ErrorResponseFromJSON` types it:

```ts
import { ErrorResponseFromJSON, ResponseError } from "@incident-io/sdk";

try {
  await incidents.incidentsV2Show({ id: "01ABC..." });
} catch (error) {
  if (error instanceof ResponseError) {
    const body = ErrorResponseFromJSON(await error.response.json());
    // Quote request_id to incident.io support.
    console.error(error.response.status, body.type, body.request_id, body.errors);
  } else {
    throw error;
  }
}
```

A network failure throws a `FetchError` instead, with the underlying error as
its `cause`.

## Timeouts

There is no default timeout. Pass an `AbortSignal` in the request options:

```ts
import { FetchError } from "@incident-io/sdk";

try {
  await incidents.incidentsV2List({ page_size: 25 }, { signal: AbortSignal.timeout(10_000) });
} catch (error) {
  if (error instanceof FetchError && error.cause.name === "TimeoutError") {
    console.error("gave up after 10 seconds");
  } else {
    throw error;
  }
}
```

## Enums

Enum fields are typed as a union of their known values, and each has a
matching constant:

```ts
import { IncidentV2ModeEnum } from "@incident-io/sdk";

const incident = (await incidents.incidentsV2Show({ id: "01ABC..." })).incident;
if (incident.mode === IncidentV2ModeEnum.Standard) {
  console.log("a real incident");
}
```

We add values to enums as a backwards-compatible change. A value this version
of the SDK doesn't know about is passed through as the string the API sent,
rather than failing the response, and is written back unchanged if you send the
object back. So don't assume the union is exhaustive: give a `switch` over an
enum a `default` branch.

## Webhooks

The payload of every webhook event has a type, named for the event, such as
`WebhooksPublicIncidentIncidentCreatedV2ResponseBody`, with a matching
`...FromJSON` to parse one. The SDK does not verify webhook signatures; see the
API reference for how to check them before trusting a payload.

## Configuration

```ts
import { Configuration } from "@incident-io/sdk";

const config = new Configuration({
  accessToken: "my-api-key",
  // Defaults to https://api.incident.io.
  basePath: "https://api.incident.io",
  // Sent with every request. Setting User-Agent here replaces the default,
  // incident-io-sdk-ts/<version>; please identify your integration.
  headers: { "User-Agent": "my-app/1.0.0" },
});
```

`accessToken` is the one credential this API uses. `apiKey`, `username`,
`password` and `credentials` are emitted by the code generator and have no
effect here.

`fetchApi` replaces the `fetch` the client calls, for proxies or a runtime
without a global `fetch`. `middleware` takes `pre`, `post` and `onError` hooks
that run around every request. Headers passed in a request's options are added
to the configuration's, replacing any of the same name. To remove a header for
one request, pass the options as a function instead: it receives the full
request, and the headers it returns replace the lot.

### Retries

The client makes a **single attempt** per request and does not retry.

The API rate-limits each key, and answers a `429` with a `Retry-After` header
in seconds. Prefer it over `X-RateLimit-Reset`: it is a duration, so it does
not depend on your clock, and it says when a single request will succeed rather
than when your whole allowance is back. Retry on `429` and `5xx`, and back off
exponentially when there is no `Retry-After`. A `fetchApi` wrapper is the
simplest place to do that:

```ts
async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(input, init);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 3) {
      return response;
    }
    const seconds = Number(response.headers.get("Retry-After")) || 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

const retrying = new Configuration({ accessToken: "my-api-key", fetchApi: fetchWithRetry });
```

### Endpoints that don't take an API key

A few endpoints send no API key, because the schema says they need none.

Two are public: `utilitiesV1IPRanges` and `utilitiesV1OpenAPIV3`.

The other two authenticate with the secret from the alert source or heartbeat
you're posting to: `alertEventsV2CreateHTTP` and `heartbeatV2Ping`. Pass it as
the `authorization` parameter:

```ts
import { AlertEventsV2Api } from "@incident-io/sdk";

const alertEvents = new AlertEventsV2Api(new Configuration());

await alertEvents.alertEventsV2CreateHTTP({
  alert_source_config_id: "01ABC...",
  authorization: "Bearer my-alert-source-secret",
  body: {
    title: "Checkout error rate above 5%",
    status: "firing",
    deduplication_key: "checkout-error-rate",
  },
});
```

There are two heartbeat methods with the same documentation, because the
schema documents both verbs on the same path: `heartbeatV2Ping` is the POST and
takes the source secret as above, and `heartbeatV2Ping1` is the GET and takes
an ordinary API key from the configuration. Don't pass `authorization` to
`heartbeatV2Ping1` as well: both would be sent. Both methods also accept the
secret as a `token` parameter, for callers that cannot set headers.

### Deprecated endpoints

Deprecated endpoints stay available and are marked `@deprecated`, so your
editor strikes them through and linters can flag them. Don't assume a `v2`
endpoint is current: parts of Catalog V2, Follow-ups V2 and Actions V2 are
deprecated, among others. Let the marker tell you rather than
the version in the name. The release fails if the schema marks an endpoint
deprecated and the generated code doesn't.

### TypeScript and the DOM library

The declarations name `fetch`'s own types, like `RequestInit`, `Response` and
`RequestCredentials`, and TypeScript declares some of those only in its DOM
library. Include `"dom"` in `lib` in your `tsconfig.json`, even in a Node
project: `@types/node` alone does not declare them all, and without `"dom"` the
package's declarations fail to compile unless `skipLibCheck` is on.

## Versioning

Releases are cut automatically. A job checks the published API schema hourly,
and when it has changed, regenerates this package, runs the tests, and
publishes a new **minor** version.

Two gates stand in front of that. [oasdiff](https://github.com/oasdiff/oasdiff)
compares the old and new schemas, and a check of the package's exported names,
properties and parameters compares the TypeScript API against the last
release. If either reports a breaking change, the release stops and a human
decides what to do, so a break is never published as a minor version.

Patch versions are only cut by hand, for a fix to this package that isn't a
schema change.

## Support

Found a bug or missing something? Please
[open an issue](https://github.com/incident-io/sdk-ts/issues). For questions
about the API itself, see the [API docs](https://api-docs.incident.io/).

Everything under `src/` is generated, so please don't send PRs editing it
directly; changes there come from the upstream schema. See
[CONTRIBUTING.md](./CONTRIBUTING.md) if you want to work on the repo itself.

## License

MIT, see [LICENSE](./LICENSE).

This SDK's generated code is produced by
[openapi-generator](https://github.com/OpenAPITools/openapi-generator), which
is licensed under Apache 2.0.
