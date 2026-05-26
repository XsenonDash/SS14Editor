using System.Collections.Generic;

namespace Content.Editor.Editor;

/// <summary>
/// DTO returned by <c>/api/tree</c>. Represents one node (file or folder) in
/// the project's Prototypes tree.
/// </summary>
internal sealed class FileTreeNode
{
    public string Name { get; set; } = "";
    public string Path { get; set; } = "";
    public bool IsDir { get; set; }
    public bool ReadOnly { get; set; }
    public List<FileTreeNode>? Children { get; set; }
}

/// <summary>
/// One row in the prototype index — the canonical record we keep in-memory
/// for every prototype declaration found in the project's YAML.
/// </summary>
internal sealed class ProtoIndexEntry
{
    public string Id { get; set; } = "";
    public string? Name { get; set; }
    public string File { get; set; } = "";
    public string[]? Parents { get; set; }
    public bool Abstract { get; set; }
    public bool ReadOnly { get; set; }
}

/// <summary>
/// Compact projection of <see cref="ProtoIndexEntry"/> used by
/// <c>/api/search-protos</c> — only the fields the UI's typeahead needs.
/// </summary>
internal sealed class ProtoSearchResult
{
    public string Id { get; set; } = "";
    public string? Name { get; set; }
}
