using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Threading.Tasks;

namespace Content.Editor.Editor;

internal sealed partial class ApiRouter
{
    private Task HandleTextureAsync(HttpListenerRequest req, HttpListenerResponse res)
        => ServeUnderAsync(res, ScopedCtx.TexturesDir, NormalizeAssetPath(req.QueryString["path"], "Textures/"), requirePath: true);

    private Task HandleTextureBrowseAsync(HttpListenerRequest req, HttpListenerResponse res)
        => BrowseUnderAsync(res, ScopedCtx.TexturesDir, NormalizeAssetPath(req.QueryString["path"] ?? "", "Textures/"));

    private Task HandleAudioAsync(HttpListenerRequest req, HttpListenerResponse res)
        => ServeUnderAsync(res, ScopedCtx.AudioDir, NormalizeAssetPath(req.QueryString["path"], "Audio/"), requirePath: true);

    private Task HandleAudioBrowseAsync(HttpListenerRequest req, HttpListenerResponse res)
        => BrowseUnderAsync(res, ScopedCtx.AudioDir, NormalizeAssetPath(req.QueryString["path"] ?? "", "Audio/"));

    /// <summary>
    /// Generic <c>ResPath</c> serving: any file under <c>Resources/</c>. Used
    /// by the generic ResPath autocomplete to preview images / play audio
    /// without caring which sub-tree the file lives in.
    /// </summary>
    private Task HandleResourceAsync(HttpListenerRequest req, HttpListenerResponse res)
        => ServeUnderAsync(res, ScopedCtx.ResourcesDir, NormalizeAssetPath(req.QueryString["path"], null), requirePath: true);

    /// <summary>
    /// Browse directories under <c>Resources/</c>. Mirrors
    /// <see cref="HandleTextureBrowseAsync"/> but rooted at the
    /// project-wide resource tree so any <c>ResPath</c> field can find files
    /// across Textures/, Audio/, Prototypes/, etc.
    /// </summary>
    private Task HandleResourceBrowseAsync(HttpListenerRequest req, HttpListenerResponse res)
        => BrowseUnderAsync(res, ScopedCtx.ResourcesDir, NormalizeAssetPath(req.QueryString["path"] ?? "", null));

    /// <summary>
    /// Resolves a client-supplied asset path under <paramref name="baseDir"/>
    /// and streams the file with a short cache header. Returns 400 on missing
    /// path (when <paramref name="requirePath"/> is true), 403 if path escapes
    /// the base directory, 404 if the file does not exist.
    /// </summary>
    private static async Task ServeUnderAsync(HttpListenerResponse res, string baseDir, string? relPath, bool requirePath)
    {
        if (requirePath && string.IsNullOrEmpty(relPath))
        {
            await HttpJson.WriteErrorAsync(res, 400, "Missing 'path' query parameter");
            return;
        }
        var fullPath = PathSecurity.Resolve(baseDir, relPath ?? "");
        if (fullPath == null)
        {
            await HttpJson.WriteErrorAsync(res, 403, "Access denied");
            return;
        }
        if (!File.Exists(fullPath))
        {
            await HttpJson.WriteErrorAsync(res, 404, "File not found");
            return;
        }
        res.ContentType = StaticMime.For(fullPath);
        res.AddHeader("Cache-Control", "public, max-age=300");
        var bytes = await File.ReadAllBytesAsync(fullPath);
        res.ContentLength64 = bytes.Length;
        await res.OutputStream.WriteAsync(bytes);
    }

    /// <summary>
    /// Lists immediate child directories and files under
    /// <paramref name="baseDir"/>/<paramref name="relPath"/>. Hidden files
    /// (leading dot) are filtered. Missing directory returns an empty result,
    /// not 404, so the autocomplete UI can keep typing without an error.
    /// </summary>
    private static async Task BrowseUnderAsync(HttpListenerResponse res, string baseDir, string relPath)
    {
        var lookup = relPath.Length == 0 ? "." : relPath;
        var fullPath = PathSecurity.Resolve(baseDir, lookup);
        if (fullPath == null)
        {
            await HttpJson.WriteErrorAsync(res, 403, "Access denied");
            return;
        }
        if (!Directory.Exists(fullPath))
        {
            await HttpJson.WriteAsync(res, new { dirs = Array.Empty<string>(), files = Array.Empty<string>() });
            return;
        }
        var dirs = Directory.GetDirectories(fullPath).Select(Path.GetFileName).OrderBy(n => n).ToList();
        var files = Directory.GetFiles(fullPath).Select(Path.GetFileName)
            .Where(n => n != null && !n.StartsWith('.'))
            .OrderBy(n => n).ToList();
        await HttpJson.WriteAsync(res, new { dirs, files });
    }

    /// <summary>
    /// Normalises a client-supplied asset path so both
    /// <c>"Objects/Tools/wrench.rsi"</c> and the SS14-style absolute form
    /// <c>"/Textures/Objects/Tools/wrench.rsi"</c> resolve to the same file.
    /// Pass <paramref name="stripPrefix"/> = "Textures/" / "Audio/" for the
    /// asset-specific endpoints, or null for the generic Resources serving.
    /// </summary>
    private static string NormalizeAssetPath(string? path, string? stripPrefix)
    {
        if (string.IsNullOrEmpty(path)) return "";
        var p = path.Replace('\\', '/').TrimStart('/');
        if (stripPrefix != null && p.StartsWith(stripPrefix, StringComparison.OrdinalIgnoreCase))
            p = p[stripPrefix.Length..];
        return p.Replace('/', Path.DirectorySeparatorChar);
    }
}
