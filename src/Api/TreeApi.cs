using System;
using System.IO;
using System.Net;
using System.Threading.Tasks;

namespace Content.Editor.Editor;

internal sealed partial class ApiRouter
{
    private Task HandleTreeAsync(HttpListenerRequest req, HttpListenerResponse res)
        => HttpJson.WriteAsync(res, ScopedCtx.GetTreeSnapshot());

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

    private async Task HandleRefreshIndexAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var ctx = ScopedCtx;
        // Rebuild() touches every YAML file under the project — on large
        // forks this can take seconds. Off-thread it so the HttpListener
        // worker is free to dispatch other requests.
        await Task.Run(() => ctx.ProtoIndex.Rebuild());
        ctx.InvalidateTree();
        await HttpJson.WriteAsync(res, new { count = ctx.ProtoIndex.TotalCount });
    }
}
