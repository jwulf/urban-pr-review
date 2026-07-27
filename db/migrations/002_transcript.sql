-- Auditability: keep the agent's full transcript (the harness's byte-capped
-- stdout capture, surfaced on the io.nanobpm.agentResult envelope) alongside the
-- round it produced and any escalation it raised, so a human can see exactly what
-- the agent did without re-running it.

ALTER TABLE rounds ADD COLUMN transcript TEXT;
ALTER TABLE escalations ADD COLUMN transcript TEXT;
