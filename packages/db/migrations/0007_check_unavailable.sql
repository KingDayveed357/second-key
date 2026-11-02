-- ADR-0020 §4: whether an "unknown" check is a technical failure (the check couldn't run or gave no
-- usable answer) is a stored fact, not something re-derived from its wording. Hold classification
-- reads this column; a failure is never shown as a finding.
ALTER TABLE checks ADD COLUMN unavailable boolean NOT NULL DEFAULT false;

-- Existing rows: the AI checks recorded before this column used these wordings for every failure path.
UPDATE checks SET unavailable = true
 WHERE kind = 'ai' AND result = 'unknown'
   AND (detail LIKE '%unavailable (%' OR detail LIKE '%no usable verdict from the model%' OR detail LIKE 'required check % did not run%');
