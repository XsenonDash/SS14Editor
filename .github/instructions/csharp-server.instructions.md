---
description: "Rules for editing server C# source under src/. Covers namespace, internal-by-default, test-update obligations, and path safety."
applyTo: "src/**/*.cs"
---

# C# Server Code Rules

## Namespace and visibility
- Namespace is **`Content.Redactor.Redactor`** (yes, doubled). Do not "fix" it.
- All `src/**/*.cs` files share this single namespace regardless of subfolder (`src/Api/`, `src/Core/`, `src/Services/`, `src/Metadata/`, `src/Http/`). Subfolders are for human navigation only.
- Types are `internal sealed` by default unless they must be exposed for serialization.
- The main project lists `[assembly: InternalsVisibleTo("ss14-redactor.Tests")]` in [src/InternalsVisibleTo.cs](../../src/InternalsVisibleTo.cs) — keep classes `internal`; the test project sees them.

## Test maintenance is mandatory
When you modify any of these files, also update the corresponding test file (or add tests if absent):

| Source | Tests |
|---|---|
| [src/Core/PathSecurity.cs](../../src/Core/PathSecurity.cs) | [tests/ss14-redactor.Tests/PathSecurityTests.cs](../../tests/ss14-redactor.Tests/PathSecurityTests.cs) |
| [src/Core/RedactorContext.cs](../../src/Core/RedactorContext.cs) (StaticMime) | [tests/ss14-redactor.Tests/StaticMimeTests.cs](../../tests/ss14-redactor.Tests/StaticMimeTests.cs) |
| [src/Services/YamlPrototypeScanner.cs](../../src/Services/YamlPrototypeScanner.cs) | [tests/ss14-redactor.Tests/YamlPrototypeScannerTests.cs](../../tests/ss14-redactor.Tests/YamlPrototypeScannerTests.cs) |
| [src/Services/FileTreeService.cs](../../src/Services/FileTreeService.cs) | [tests/ss14-redactor.Tests/FileTreeServiceTests.cs](../../tests/ss14-redactor.Tests/FileTreeServiceTests.cs) |
| [src/Services/ProtoIndexService.cs](../../src/Services/ProtoIndexService.cs) | [tests/ss14-redactor.Tests/ProtoIndexServiceTests.cs](../../tests/ss14-redactor.Tests/ProtoIndexServiceTests.cs) |
| [src/Services/SourceLocator.cs](../../src/Services/SourceLocator.cs) | [tests/ss14-redactor.Tests/SourceLocatorTests.cs](../../tests/ss14-redactor.Tests/SourceLocatorTests.cs) |
| [src/Metadata/XmlDocReader.cs](../../src/Metadata/XmlDocReader.cs) | [tests/ss14-redactor.Tests/XmlDocReaderTests.cs](../../tests/ss14-redactor.Tests/XmlDocReaderTests.cs) |
| [src/Metadata/FieldExtractor.cs](../../src/Metadata/FieldExtractor.cs) | [tests/ss14-redactor.Tests/FieldExtractorTests.cs](../../tests/ss14-redactor.Tests/FieldExtractorTests.cs) |
| [src/Metadata/MetadataExtractor.cs](../../src/Metadata/MetadataExtractor.cs) | [tests/ss14-redactor.Tests/MetadataExtractorTests.cs](../../tests/ss14-redactor.Tests/MetadataExtractorTests.cs) |
| [src/Http/HttpJson.cs](../../src/Http/HttpJson.cs) | [tests/ss14-redactor.Tests/HttpJsonTests.cs](../../tests/ss14-redactor.Tests/HttpJsonTests.cs) |
| [src/Api/\*.cs](../../src/Api/) | [tests/ss14-redactor.Tests/ApiRouterTests.cs](../../tests/ss14-redactor.Tests/ApiRouterTests.cs) |

After editing, run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests\ss14-redactor.Tests\ss14-redactor.Tests.csproj`.

## Path safety
- Any filesystem path that comes from an HTTP request body or query string **must** pass through `PathSecurity.Resolve` / `PathSecurity.NormalizeRelative` before being combined with a server-side root. Do not call `Path.Combine` on attacker-controlled strings directly.
- When adding a new mount point (e.g. a textures root), add a constant or helper rather than passing raw strings around.

## Logging
- Current convention is `Console.WriteLine` / `Console.Error.WriteLine` with a `[Redactor]` prefix. Match it. Do not introduce a new logging library without consensus.

## Reflection-heavy code
- `MetadataLoadContext`-based code ([src/Metadata/MetadataExtractor.cs](../../src/Metadata/MetadataExtractor.cs), [src/Metadata/FieldExtractor.cs](../../src/Metadata/FieldExtractor.cs)) must remain side-effect-free with respect to user code: never call `Activator.CreateInstance` on game types, never enumerate beyond reflection.
- Production reflection code identifies SS14 attributes by `CustomAttributeData.AttributeType.Name` (string match). Tests rely on this: see [tests/ss14-redactor.Tests/Fixtures/FixtureTypes.cs](../../tests/ss14-redactor.Tests/Fixtures/FixtureTypes.cs) — do not switch to type-identity matching without updating the test fixtures.
