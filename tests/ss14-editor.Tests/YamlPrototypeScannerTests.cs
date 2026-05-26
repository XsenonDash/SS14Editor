using System.Collections.Generic;
using Content.Editor.Editor;
using Xunit;

namespace Content.Editor.Tests;

public class YamlPrototypeScannerTests
{
    private static Dictionary<string, List<ProtoIndexEntry>> ScanText(string yaml, TempDir tmp, bool readOnly = false)
    {
        var file = tmp.Write("file.yml", yaml);
        var index = new Dictionary<string, List<ProtoIndexEntry>>();
        YamlPrototypeScanner.Scan(file, "file.yml", index, readOnly);
        return index;
    }

    [Fact]
    public void Scan_BasicPrototype_ExtractsTypeAndId()
    {
        using var tmp = new TempDir();
        var idx = ScanText("""
            - type: entity
              id: Foo
              name: A Foo
            """, tmp);

        Assert.Single(idx);
        Assert.True(idx.ContainsKey("entity"));
        var entry = Assert.Single(idx["entity"]);
        Assert.Equal("Foo", entry.Id);
        Assert.Equal("A Foo", entry.Name);
        Assert.Equal("file.yml", entry.File);
        Assert.False(entry.Abstract);
        Assert.False(entry.ReadOnly);
        Assert.Null(entry.Parents);
    }

    [Fact]
    public void Scan_MultiplePrototypes_AllIndexed()
    {
        using var tmp = new TempDir();
        var idx = ScanText("""
            - type: entity
              id: A
            - type: entity
              id: B
            - type: tag
              id: T1
            """, tmp);

        Assert.Equal(2, idx["entity"].Count);
        Assert.Single(idx["tag"]);
    }

    [Fact]
    public void Scan_AbstractFlag_Detected()
    {
        using var tmp = new TempDir();
        var idx = ScanText("""
            - type: entity
              id: Base
              abstract: true
            - type: entity
              id: Concrete
              abstract: false
            """, tmp);

        var entries = idx["entity"];
        Assert.True(entries.Find(e => e.Id == "Base")!.Abstract);
        Assert.False(entries.Find(e => e.Id == "Concrete")!.Abstract);
    }

    [Fact]
    public void Scan_SingleParent_AsScalar()
    {
        using var tmp = new TempDir();
        var idx = ScanText("""
            - type: entity
              id: Child
              parent: Parent
            """, tmp);

        var entry = idx["entity"][0];
        Assert.NotNull(entry.Parents);
        Assert.Equal(new[] { "Parent" }, entry.Parents);
    }

    [Fact]
    public void Scan_MultipleParents_AsSequence()
    {
        using var tmp = new TempDir();
        var idx = ScanText("""
            - type: entity
              id: Child
              parent:
                - A
                - B
                - C
            """, tmp);

        var entry = idx["entity"][0];
        Assert.Equal(new[] { "A", "B", "C" }, entry.Parents);
    }

    [Fact]
    public void Scan_MissingTypeOrId_Skipped()
    {
        using var tmp = new TempDir();
        var idx = ScanText("""
            - type: entity
              # no id
              name: Anon
            - id: Orphan
              # no type
            - type: entity
              id: Good
            """, tmp);

        var entries = Assert.Single(idx).Value;
        Assert.Single(entries);
        Assert.Equal("Good", entries[0].Id);
    }

    [Fact]
    public void Scan_InvalidYaml_DoesNotThrow_LeavesIndexUntouched()
    {
        using var tmp = new TempDir();
        var idx = ScanText("not: [valid: yaml: at all", tmp);
        Assert.Empty(idx);
    }

    [Fact]
    public void Scan_MissingFile_DoesNotThrow()
    {
        var index = new Dictionary<string, List<ProtoIndexEntry>>();
        // Should not throw — IOException is caught.
        YamlPrototypeScanner.Scan("/no/such/file.yml", "x.yml", index);
        Assert.Empty(index);
    }

    [Fact]
    public void Scan_NonSequenceRoot_Ignored()
    {
        using var tmp = new TempDir();
        var idx = ScanText("""
            type: entity
            id: NotInSequence
            """, tmp);
        Assert.Empty(idx);
    }

    [Fact]
    public void Scan_ReadOnlyFlag_PropagatedToEntries()
    {
        using var tmp = new TempDir();
        var idx = ScanText("""
            - type: entity
              id: EngineProto
            """, tmp, readOnly: true);

        Assert.True(idx["entity"][0].ReadOnly);
    }

    [Fact]
    public void Scan_WithCustomTag_StillExtractsScalars()
    {
        using var tmp = new TempDir();
        // !type: is the SS14 idiom for polymorphic component lists; scanner
        // should not choke on unknown tags.
        var idx = ScanText("""
            - type: entity
              id: Tagged
              components:
                - !type:Foo
                  field: value
            """, tmp);

        var entries = Assert.Single(idx).Value;
        Assert.Equal("Tagged", entries[0].Id);
    }

    [Fact]
    public void Scan_EntityTable_GroupSelector_WithShorthandChildren_IndexesRoot()
    {
        using var tmp = new TempDir();
        // EntityTableTypeSerializer allows bare `- id: EntityName` entries
        // without !type: inside children lists. The root prototype id must
        // still be indexed correctly and the nested `id:` values must NOT
        // be picked up as the prototype id.
        var idx = ScanText("""
            - type: entityTable
              id: SalvageMobTable
              table: !type:GroupSelector
                children:
                - id: MobCarpSalvage
                  weight: 5
                - id: MobTickSalvage
                  weight: 3
                - !type:NestedSelector
                  tableId: OtherTable
            """, tmp);

        Assert.True(idx.ContainsKey("entityTable"));
        var entry = Assert.Single(idx["entityTable"]);
        Assert.Equal("SalvageMobTable", entry.Id);
    }

    [Fact]
    public void Scan_EntityTable_AllSelector_NestedAllSelector_IndexesAllTables()
    {
        using var tmp = new TempDir();
        var idx = ScanText("""
            - type: entityTable
              id: FillLockerWarden
              table: !type:AllSelector
                children:
                - id: FlashlightSeclite
                - id: WeaponDisabler
                  prob: 0.5
            - type: entityTable
              id: FillLockerCaptain
              table: !type:AllSelector
                children:
                - id: ClothingHeadHatCapCap
            """, tmp);

        Assert.True(idx.ContainsKey("entityTable"));
        Assert.Equal(2, idx["entityTable"].Count);
        Assert.Contains(idx["entityTable"], e => e.Id == "FillLockerWarden");
        Assert.Contains(idx["entityTable"], e => e.Id == "FillLockerCaptain");
    }

    [Fact]
    public void Scan_EntityTable_NestedSelectors_DoNotPolluteMobTable()
    {
        using var tmp = new TempDir();
        // A file mixing entityTable and entity prototypes: entity ids inside
        // entityTable children must not leak into the entity index.
        var idx = ScanText("""
            - type: entity
              id: RealEntity
            - type: entityTable
              id: MyTable
              table: !type:GroupSelector
                children:
                - id: FakeEntity
                  weight: 1
            """, tmp);

        Assert.Single(idx["entity"]);
        Assert.Equal("RealEntity", idx["entity"][0].Id);
        Assert.Single(idx["entityTable"]);
        Assert.Equal("MyTable", idx["entityTable"][0].Id);
    }
}
