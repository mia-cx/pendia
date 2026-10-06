# @thalia/plugin-webhooks

Sends Thalia server events to an HTTP endpoint. First-party, listed in the official registry.

## Settings

- URL: where each event goes. Nothing is sent until it is set.
- Method: POST, PUT or PATCH.
- Headers: a list of `"Name: value"` strings, such as `["Authorization: Bearer abc"]`. `Content-Type` defaults to `application/json`.
- Events: which events to send. `item.added` by default.
- Body: the template, see below.
- Retries: how often to retry a 5xx answer or an unreachable endpoint, from 0 to 10, waiting 1 s, 2 s, 4 s and so on. A 3xx or 4xx answer is logged and not retried; redirects are not followed, so point the URL at the final endpoint. After the last retry the failure goes to the plugin log, which names the endpoint's origin but never its path or headers, since those often hold tokens.

## Body template

`{{path}}` inserts a value from the event:

- `event`: the event name, such as `item.added`.
- `timestamp`: when the plugin sent it, as an ISO date.
- `data`: the event payload, such as `{ "itemId": "...", "kind": "movie" }`.
- `item`: the Item the event names, with title, year, provider ids and Versions, or `null`.

Dotted paths reach inside: `{{item.title}}`, `{{data.kind}}`. A string goes in escaped for a JSON string, so wrap it in quotes; any other value goes in as JSON. A Discord webhook body:

```json
{"content":"Added {{item.title}} ({{item.year}})"}
```

The default body sends everything:

```json
{"event":"{{event}}","timestamp":"{{timestamp}}","data":{{data}},"item":{{item}}}
```

## Capabilities

`events`, `items:read` to fill in `item`, and `network` with `"*"`, since the URL is whatever the admin enters.
