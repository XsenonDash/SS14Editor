using System;
using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Content.Editor.Editor;

/// <summary>
/// Maintains a set of long-lived HTTP responses configured for Server-Sent
/// Events and broadcasts JSON messages to all subscribers.
///
/// THREADING — read this before editing!
/// =====================================
/// <see cref="HttpListenerResponse.OutputStream"/> is NOT thread-safe.
/// Writes from the heartbeat timer, file-watcher events, and per-subscriber
/// startup messages all race for the same socket. Interleaving any two
/// writes mid-frame corrupts the SSE wire format and the client disconnects.
///
/// We serialize per-subscriber writes with a <see cref="SemaphoreSlim"/> held
/// for the duration of each <c>data: …\n\n</c> record. NEVER call
/// <c>res.OutputStream.WriteAsync</c> directly — go through <c>SendAsync</c>.
///
/// DISPOSAL: the service is owned by <see cref="EditorContext"/>; when the
/// context is released, <see cref="Dispose"/> stops the heartbeat and closes
/// every subscriber socket. Broadcasts after disposal are silent no-ops.
/// </summary>
internal sealed class EventStreamService : IDisposable
{
    private sealed class Subscriber
    {
        public required HttpListenerResponse Response { get; init; }
        public SemaphoreSlim WriteLock { get; } = new(1, 1);
    }

    private readonly ConcurrentDictionary<Guid, Subscriber> _subscribers = new();
    private readonly Timer _heartbeat;
    private int _disposed;

    public EventStreamService()
    {
        _heartbeat = new Timer(_ => Broadcast(new { type = "ping" }),
            null, TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(15));
    }

    /// <summary>
    /// Attaches the supplied response as an SSE subscriber. The returned task
    /// completes when the connection is closed or torn down by the client.
    /// </summary>
    public async Task SubscribeAsync(HttpListenerResponse res, CancellationToken ct)
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            try { res.Close(); } catch { }
            return;
        }

        res.StatusCode = 200;
        res.ContentType = "text/event-stream";
        res.AddHeader("Cache-Control", "no-cache");
        res.AddHeader("Connection", "keep-alive");
        res.SendChunked = true;

        var sub = new Subscriber { Response = res };
        var id = Guid.NewGuid();
        _subscribers[id] = sub;

        try
        {
            // Send an initial "ready" event so the client knows the channel is live.
            await SendAsync(sub, new { type = "ready" });
            // Block while the connection is held open. The response is closed
            // either by Dispose (server shutdown) or by a write failure.
            await Task.Delay(Timeout.Infinite, ct);
        }
        catch (TaskCanceledException) { /* expected on shutdown */ }
        catch (Exception) { /* connection torn down */ }
        finally
        {
            _subscribers.TryRemove(id, out _);
            sub.WriteLock.Dispose();
            try { res.Close(); } catch { /* already closed */ }
        }
    }

    public void Broadcast(object payload)
    {
        if (Volatile.Read(ref _disposed) != 0) return;
        if (_subscribers.IsEmpty) return;
        foreach (var (id, sub) in _subscribers)
        {
            _ = SendAsync(sub, payload).ContinueWith(t =>
            {
                if (t.IsFaulted) _subscribers.TryRemove(id, out _);
            }, TaskScheduler.Default);
        }
    }

    private static async Task SendAsync(Subscriber sub, object payload)
    {
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        });
        var bytes = Encoding.UTF8.GetBytes($"data: {json}\n\n");
        // CRITICAL: serialize writes per-subscriber so concurrent broadcasts
        // (heartbeat + file-change) can't interleave bytes inside one frame.
        await sub.WriteLock.WaitAsync();
        try
        {
            await sub.Response.OutputStream.WriteAsync(bytes);
            await sub.Response.OutputStream.FlushAsync();
        }
        finally
        {
            sub.WriteLock.Release();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try { _heartbeat.Dispose(); } catch { }
        foreach (var (_, sub) in _subscribers)
        {
            try { sub.Response.Close(); } catch { }
        }
        _subscribers.Clear();
    }
}
