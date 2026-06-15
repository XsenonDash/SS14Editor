using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace Content.Editor.Tests;

/// <summary>
/// Runs the JavaScript test suites for WebUI YAML helpers via Node.js.
/// The actual assertions live in tests/yaml/*.test.js (the from-scratch build
/// + comment/respectful suite in potion-ultra.test.js and the bug regression
/// guards in regression-respectful.test.js). This class is just the xUnit
/// entry-point so `dotnet test` covers JS behaviour automatically. Every
/// *.test.js under tests/yaml is discovered, so new suites are picked up
/// without touching this file.
/// </summary>
public class YamlJsTests
{
    public static IEnumerable<object[]> JsTestFiles()
    {
        var dir = Path.Combine(FindRepoRoot(), "tests", "yaml");
        foreach (var f in Directory.GetFiles(dir, "*.test.js"))
            yield return new object[] { Path.GetFileName(f) };
    }

    [Theory]
    [MemberData(nameof(JsTestFiles))]
    public void JsSuitePasses(string fileName)
    {
        var repoRoot   = FindRepoRoot();
        var scriptPath = Path.Combine(repoRoot, "tests", "yaml", fileName);

        using var proc = Process.Start(new ProcessStartInfo
        {
            FileName         = "node",
            ArgumentList     = { scriptPath },
            WorkingDirectory = repoRoot,
            RedirectStandardOutput = true,
            RedirectStandardError  = true,
            UseShellExecute  = false
        })!;

        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit();

        var output = (stdout + "\n" + stderr).Trim();
        Assert.True(proc.ExitCode == 0,
            $"JS tests failed in {fileName} (exit {proc.ExitCode}):\n{output}");
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "ss14-editor.csproj")))
                return dir.FullName;
            dir = dir.Parent;
        }
        throw new InvalidOperationException(
            "Could not locate repo root (ss14-editor.csproj not found)");
    }
}
