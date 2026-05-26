using System;
using System.IO;
using System.Net;
using System.Threading.Tasks;

namespace Content.Editor.Editor;

internal sealed partial class ApiRouter
{
    private Task HandleTreeAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var ctx = ScopedCtx;
        var tree = FileTreeService.Build(ctx.PrototypesDir);
        if (Directory.Exists(ctx.EnginePrototypesDir))
        {
            var engineTree = FileTreeService.Build(ctx.EnginePrototypesDir, "", ProtoIndexService.EnginePrefix);
            FileTreeService.MarkReadOnly(engineTree);
            tree.Add(new FileTreeNode
            {
                Name = "⚙ Engine (read-only)",
                Path = "__engine__",
                IsDir = true,
                ReadOnly = true,
                Children = engineTree,
            });
        }
        return HttpJson.WriteAsync(res, tree);
    }

    private async Task HandleMetadataAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var ctx = ScopedCtx;
        var metaPath = Path.Combine(ctx.EditorDir, "metadata.json");
        if (!File.Exists(metaPath))
        {
            await HttpJson.WriteErrorAsync(res, 404, "metadata.json not found. Build the project first.");
            return;
        }
        var bytes = await File.ReadAllBytesAsync(metaPath);
        res.ContentLength64 = bytes.Length;
        await res.OutputStream.WriteAsync(bytes);
    }

    private Task HandleProtoIndexAsync(HttpListenerRequest req, HttpListenerResponse res)
        => HttpJson.WriteAsync(res, ScopedCtx.ProtoIndex.Index);

    private Task HandleGitStatusAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var ctx = ScopedCtx;
        var r = GitStatusService.Query(ctx.SolutionRoot, ctx.PrototypesDir);
        return HttpJson.WriteAsync(res, new { available = r.Available, files = r.Files });
    }

    private Task HandleSearchProtosAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var q = req.QueryString["q"] ?? "";
        var type = req.QueryString["type"] ?? "entity";
        var limit = int.TryParse(req.QueryString["limit"], out var l) ? l : 50;
        return HttpJson.WriteAsync(res, ScopedCtx.ProtoIndex.Search(type, q, limit));
    }

    private Task HandleRefreshIndexAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var ctx = ScopedCtx;
        ctx.ProtoIndex.Rebuild();
        return HttpJson.WriteAsync(res, new { count = ctx.ProtoIndex.TotalCount });
    }
}
