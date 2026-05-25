using System;

#pragma warning disable CS0649 // Fixture fields are never written: they exist for reflection only.

namespace Content.Redactor.Tests.Fixtures;

// Fixture attributes mimicking SS14 ones. MetadataExtractor / FieldExtractor
// recognise attributes purely by Name (string), so we do not need to reference
// the real SS14 types.

[AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct)]
internal sealed class PrototypeAttribute : Attribute
{
    public string YamlType { get; }
    public PrototypeAttribute(string yamlType) { YamlType = yamlType; }
}

[AttributeUsage(AttributeTargets.Class)]
internal sealed class RegisterComponentAttribute : Attribute { }

[AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct)]
internal sealed class DataDefinitionAttribute : Attribute { }

[AttributeUsage(AttributeTargets.Class)]
internal sealed class ImplicitDataDefinitionForInheritorsAttribute : Attribute { }

[AttributeUsage(AttributeTargets.Field | AttributeTargets.Property)]
internal sealed class DataFieldAttribute : Attribute
{
    public string? Tag { get; }
    public bool Required { get; set; }
    public DataFieldAttribute() { }
    public DataFieldAttribute(string tag) { Tag = tag; }
    // 4-arg ctor used by ResolveRequired's positional-arg path.
    public DataFieldAttribute(string tag, Type? serializer, bool readOnly, bool required)
    { Tag = tag; Required = required; }
}

[AttributeUsage(AttributeTargets.Field | AttributeTargets.Property)]
internal sealed class IdDataFieldAttribute : Attribute { }

[AttributeUsage(AttributeTargets.Field | AttributeTargets.Property)]
internal sealed class ParentDataFieldAttribute : Attribute { }

[AttributeUsage(AttributeTargets.Field | AttributeTargets.Property)]
internal sealed class AbstractDataFieldAttribute : Attribute { }

[AttributeUsage(AttributeTargets.Field | AttributeTargets.Property)]
internal sealed class AlwaysPushInheritanceAttribute : Attribute { }

[AttributeUsage(AttributeTargets.Field | AttributeTargets.Property)]
internal sealed class NeverPushInheritanceAttribute : Attribute { }

internal interface IInheritingPrototype { }

internal enum FixtureMood { Happy, Sad, Neutral }

[Flags]
internal enum FixtureFlags { None = 0, A = 1, B = 2 }

// ---------- Prototype with various field shapes ----------

[Prototype("fixtureEntity")]
internal sealed class FixtureEntityPrototype : IInheritingPrototype
{
    [IdDataField] public string Id { get; set; } = "";
    [ParentDataField] public string? Parent { get; set; }
    [AbstractDataField] public bool Abstract { get; set; }

    [DataField] public string? Name;
    [DataField("renamed")] public int Count;
    [DataField(Required = true)] public bool Enabled;
    [DataField] public FixtureMood Mood;
    [DataField] public FixtureFlags Flags;
    [DataField] public System.Collections.Generic.List<string>? Tags;
    [DataField] public System.Collections.Generic.Dictionary<string, int>? Counters;
    [DataField] public FixtureDataDef? Nested;
}

[Prototype("fixtureSimple")]
internal sealed class FixtureSimplePrototype
{
    [IdDataField] public string Id { get; set; } = "";
}

[DataDefinition]
internal sealed class FixtureDataDef
{
    [DataField] public string? Label;
    [DataField] public float Weight;
}

[ImplicitDataDefinitionForInheritors]
internal abstract class FixtureBaseEffect
{
    [DataField] public float Probability;
}

internal sealed class FixtureConcreteEffect : FixtureBaseEffect
{
    [DataField] public string? Message;
}

[RegisterComponent]
internal sealed class FixtureLightComponent
{
    [DataField] public float Radius;
    [DataField] public string? Sprite;
}
