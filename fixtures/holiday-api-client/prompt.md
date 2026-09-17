We are integrating with Holidaze, a third-party public-holidays API. Add a client for it.

API (base URL `https://api.holidaze.example/v1`, authenticated with the header
`X-Api-Key: <key>`):

- `GET /holidays?country=<ISO-3166 alpha-2>&year=<YYYY>` returns
  `{ "holidays": [ { "date": "YYYY-MM-DD", "name": string, "regional": boolean } ] }`.
- `429` responses carry a `Retry-After` header in seconds. `5xx` responses are transient.
- `401` means the key is invalid. `404` means the country is not supported.

The client should:

- Take the API key and base URL from this project's configuration mechanism; do not hardcode
  the key.
- Expose one operation: fetch holidays for a country and year, returning typed results in the
  project's style.
- Time out requests (10 seconds by default) and retry transient failures (`429`, `5xx`, network
  errors) up to 3 times with backoff, honouring `Retry-After` when present.
- Surface `401` and `404` as distinct, meaningful errors rather than generic failures.

Write tests that mock the HTTP layer the way this project already does (or in the idiomatic way
for its stack if nothing exists yet). No test may make a real network call. Cover the success
path, each error class, the retry-then-succeed path, and retries being exhausted.

Do not add dependencies beyond what the project already uses for HTTP and testing.
