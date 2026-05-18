# 01 -- Shared Validation Module

## Description

Create the validation module that extracts a component map from an A2UI spec and validates agent-submitted data against it. This is the foundation every other task depends on.

## Files to create/modify

- **Create** `apps/api/validate-agent-data.ts` -- exports `INPUT_COMPONENTS`, `extractComponentMap`, `validateAgentData`, `validateFieldValue`, and the `FieldError` type
- **Create** `apps/api/validate-agent-data.test.ts` -- unit tests

## Acceptance criteria

- `extractComponentMap(spec)` walks `spec[*].updateComponents.components` and returns a `Map<string, { component: string; [k: string]: unknown }>`.
- `INPUT_COMPONENTS` set contains exactly `TextField`, `CheckBox`, `Slider`, `ChoicePicker`, `DateTimeInput`.
- `validateAgentData(data, componentMap)` returns `FieldError[]` (empty array if all valid).
- Per-component validation rules match the spec's component type table (section 4):
  - `TextField`: string for text/obscured/longText (max 10k / 50k chars); number for variant=number with string-to-number coercion.
  - `CheckBox`: boolean only.
  - `Slider`: finite number within optional `[min, max]`.
  - `ChoicePicker`: `string[]`; single-selection requires exactly 1 element; values must be in `options[].value`.
  - `DateTimeInput`: ISO 8601 string; respects `enableDate`/`enableTime` for date-only or time-only formats.
- Keys in `data` that target non-input or unknown components are silently ignored (no error).
- Unit tests cover: every component type happy path, type mismatches, boundary values (slider min/max), ChoicePicker invalid option, DateTimeInput format variants, unknown field IDs, empty data object.

## Dependencies

None -- this is the first task.

## Relevant spec sections

- Section 4: A2UI Spec-to-Validation Mapping (full section)
- Section 7: Error taxonomy (`FieldError` type definition)
