# Changelogs

## v1.1.13
- Added a custom `SpriteComponent` handler to handle paths to RSI folders, sprite states, and sprite previews.
- Fixed a bug that caused data objects to collapse automatically when structural changes were made to the prototype.
- `SpriteComponent` is now always the topmost layer and remains visible even when minimized.
- Added the ability to swap components using drag and drop

## v1.1.12
- Hovering over a component now displays the XML summary from the code.
- Dictionary entries can now be edited after they have been created.
- Added the ability to rebuild project metadata manually.
- Rebuilding the SS14 project (changes to DLL files) automatically triggers a rebuild of the metadata.
- Support for the `customTypeSerializer` has been added for certain types. This allows, for example, proper editing of mask flags and collision layer flags within the `FixturesComponent`.

## v1.1.11
- Optimization has been implemented to reduce app freezes when editing prototypes.
- Fixed a major freeze in the editor during file searches.

## v1.1.10
- The project search now also searches by filename
- Fixed issues with launching the editor on Linux via AppImage.

## v1.1.9
- The “Help” tab and changelogs have been added.
- The changelog tab now opens automatically when the editor starts.

## v1.1.6
- Basic support for working with comments in YML has been added.
- SS14 Editor is now available to the public.