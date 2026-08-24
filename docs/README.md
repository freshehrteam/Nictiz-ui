# Diagrams

PlantUML sources for the save → FHIR translation → display flow.

| File | What it shows |
|---|---|
| [`save-to-fhir-sequence.puml`](save-to-fhir-sequence.puml) | The flow in order: save the composition to the CDR, translate it via openFHIR, store the Bundle, display it. |
| [`save-to-fhir-components.puml`](save-to-fhir-components.puml) | The five components and which of them talks to which. |

Deliberately kept at an overview level — API routes and module names are left to
the code, which says them more accurately than a diagram can keep up with.

Three things the diagrams call out, because they are not visible from the call
sites:

- **The save is finished once the CDR accepts it.** Everything after that is
  translation, and a failure there leaves the record intact — only the summary
  is unavailable.
- **The composition is read back in canonical form** for openFHIR, which maps
  from the full openEHR structure.
- **Only the Bundle id is handed to the FHIR UI**, which re-reads from HAPI. That
  is what makes reload and deep links work.

## Rendering

```bash
# VS Code: the PlantUML extension previews with Alt+D
docker run --rm -v "$PWD:/data" plantuml/plantuml -tsvg /data/docs/*.puml
```
