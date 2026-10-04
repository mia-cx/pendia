-- Drizzle's jsonb stored each value as a JSON string holding the JSON text. Unwrap those
-- strings: objects and arrays, and strings such as server.id stored as "\"<uuid>\"".
-- A plain string written by SQL, such as a provider key, is not JSON text and stays as it is.
UPDATE "settings" SET "value" = ("value" #>> '{}')::jsonb
WHERE jsonb_typeof("value") = 'string'
  AND left(ltrim("value" #>> '{}', E' \t\n\r'), 1) IN ('{', '[', '"')
  AND ("value" #>> '{}') IS JSON;
--> statement-breakpoint
UPDATE "libraries" SET "configuration" = ("configuration" #>> '{}')::jsonb
WHERE jsonb_typeof("configuration") = 'string'
  AND left(ltrim("configuration" #>> '{}', E' \t\n\r'), 1) IN ('{', '[', '"')
  AND ("configuration" #>> '{}') IS JSON;
--> statement-breakpoint
UPDATE "files" SET "chapters" = ("chapters" #>> '{}')::jsonb
WHERE jsonb_typeof("chapters") = 'string'
  AND left(ltrim("chapters" #>> '{}', E' \t\n\r'), 1) IN ('{', '[', '"')
  AND ("chapters" #>> '{}') IS JSON;
--> statement-breakpoint
UPDATE "streams" SET "disposition" = ("disposition" #>> '{}')::jsonb
WHERE jsonb_typeof("disposition") = 'string'
  AND left(ltrim("disposition" #>> '{}', E' \t\n\r'), 1) IN ('{', '[', '"')
  AND ("disposition" #>> '{}') IS JSON;
--> statement-breakpoint
UPDATE "probe_cache" SET "result" = ("result" #>> '{}')::jsonb
WHERE jsonb_typeof("result") = 'string'
  AND left(ltrim("result" #>> '{}', E' \t\n\r'), 1) IN ('{', '[', '"')
  AND ("result" #>> '{}') IS JSON;
--> statement-breakpoint
UPDATE "events" SET "payload" = ("payload" #>> '{}')::jsonb
WHERE jsonb_typeof("payload") = 'string'
  AND left(ltrim("payload" #>> '{}', E' \t\n\r'), 1) IN ('{', '[', '"')
  AND ("payload" #>> '{}') IS JSON;
--> statement-breakpoint
UPDATE "transcoder_capabilities" SET "backends" = ("backends" #>> '{}')::jsonb
WHERE jsonb_typeof("backends") = 'string'
  AND left(ltrim("backends" #>> '{}', E' \t\n\r'), 1) IN ('{', '[', '"')
  AND ("backends" #>> '{}') IS JSON;
--> statement-breakpoint
UPDATE "session_registry" SET "decision" = ("decision" #>> '{}')::jsonb
WHERE jsonb_typeof("decision") = 'string'
  AND left(ltrim("decision" #>> '{}', E' \t\n\r'), 1) IN ('{', '[', '"')
  AND ("decision" #>> '{}') IS JSON;
