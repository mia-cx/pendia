-- Decisions planned before Stream selection held one decision per audio and subtitle Stream,
-- and their runs played the first audio Stream. Keep what they played: the first audio
-- decision, each subtitle decision with its place among subtitle Streams, and that selection.
UPDATE "session_registry" SET "decision" = "decision" || jsonb_build_object(
  'audio', "decision" -> 'audio' -> 0,
  'subtitles', COALESCE(
    (SELECT jsonb_agg("subtitle" || jsonb_build_object('stream', "position" - 1) ORDER BY "position")
     FROM jsonb_array_elements("decision" -> 'subtitles') WITH ORDINALITY AS "old"("subtitle", "position")),
    '[]'::jsonb
  ),
  'selection', jsonb_build_object(
    'audio', CASE WHEN jsonb_array_length("decision" -> 'audio') > 0 THEN to_jsonb(0) ELSE 'null'::jsonb END
  )
)
WHERE jsonb_typeof("decision" -> 'audio') = 'array';
--> statement-breakpoint
UPDATE "session_registry" SET "decision" = "decision" || '{"selection":{"audio":0}}'::jsonb
WHERE "decision" ->> 'method' = 'stored' AND "decision" -> 'selection' IS NULL;
