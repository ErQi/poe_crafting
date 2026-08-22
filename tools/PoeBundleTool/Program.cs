// This helper is a separate process that links LibGGPK3/LibBundle3 v2.7.5 (AGPL-3.0).
// Its source is distributed with POE Tools; see THIRD_PARTY_NOTICES.md.
using System.Text.Json;
using LibBundle3;
using LibBundle3.Records;
using BundleIndex = LibBundle3.Index;

namespace PoeBundleTool;

internal sealed class OverlayBundleFactory(string readRoot, string overlayRoot, bool readOnly) : IBundleFactory
{
    private readonly string _readRoot = Path.GetFullPath(readRoot);
    private readonly string _overlayRoot = Path.GetFullPath(overlayRoot);

    private static string SafePath(string root, string relative)
    {
        var candidate = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        var prefix = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Bundle path escapes root: {relative}");
        return candidate;
    }

    public Bundle GetBundle(BundleRecord record)
    {
        var overlay = SafePath(_overlayRoot, record.Path);
        var file = File.Exists(overlay) ? overlay : SafePath(_readRoot, record.Path);
        var access = readOnly ? FileAccess.Read : FileAccess.ReadWrite;
        var stream = File.Open(file, FileMode.Open, access, FileShare.Read);
        return new Bundle(stream, false, record);
    }

    public Stream CreateBundle(string bundlePath)
    {
        var file = SafePath(_overlayRoot, bundlePath);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        return File.Create(file);
    }

    public bool DeleteBundle(string bundlePath)
    {
        var file = SafePath(_overlayRoot, bundlePath);
        if (!File.Exists(file)) return false;
        File.Delete(file);
        return true;
    }
}

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static string[] CustomBundles(BundleIndex index) => index.Bundles.Span
        .ToArray()
        .Select(record => record.Path.Replace('\\', '/'))
        .Where(file => file.StartsWith("LibGGPK3/", StringComparison.OrdinalIgnoreCase))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .Order(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    private static FileStream OpenIndex(string file, bool writable) => File.Open(
        Path.GetFullPath(file),
        FileMode.Open,
        writable ? FileAccess.ReadWrite : FileAccess.Read,
        FileShare.Read
    );

    private static object ListCustom(string[] args)
    {
        if (args.Length != 2) throw new ArgumentException("list-custom <index>");
        var root = Path.GetDirectoryName(Path.GetFullPath(args[1]))!;
        using var stream = OpenIndex(args[1], false);
        using var index = new BundleIndex(stream, false, false, new OverlayBundleFactory(root, root, true));
        return new { ok = true, customBundles = CustomBundles(index) };
    }

    private static object ResourceBundles(string[] args)
    {
        if (args.Length < 3) throw new ArgumentException("resource-bundles <index> <resource> [resource...]");
        var root = Path.GetDirectoryName(Path.GetFullPath(args[1]))!;
        using var stream = OpenIndex(args[1], false);
        using var index = new BundleIndex(stream, false, false, new OverlayBundleFactory(root, root, true));
        var bundles = new List<string>();
        foreach (var resource in args.Skip(2))
        {
            if (!index.TryGetFile(resource.Replace('\\', '/'), out var file) || file is null)
                throw new FileNotFoundException($"Resource not found in index: {resource}");
            bundles.Add(file.BundleRecord.Path.Replace('\\', '/'));
        }
        return new
        {
            ok = true,
            resourceBundles = bundles.Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToArray()
        };
    }

    private static object Extract(string[] args)
    {
        if (args.Length != 6) throw new ArgumentException("extract <index> <read-root> <overlay-root> <resource> <output>");
        using var stream = OpenIndex(args[1], false);
        using var index = new BundleIndex(stream, false, false, new OverlayBundleFactory(args[2], args[3], true));
        if (!index.TryGetFile(args[4].Replace('\\', '/'), out var file) || file is null)
            throw new FileNotFoundException($"Resource not found in index: {args[4]}");
        var content = file.Read();
        var output = Path.GetFullPath(args[5]);
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        File.WriteAllBytes(output, content.Span.ToArray());
        return new { ok = true, bytes = content.Length, customBundles = CustomBundles(index) };
    }

    private static object Replace(string[] args)
    {
        if (args.Length != 6) throw new ArgumentException("replace <index> <read-root> <overlay-root> <resource> <input>");
        using var stream = OpenIndex(args[1], true);
        using var index = new BundleIndex(stream, false, false, new OverlayBundleFactory(args[2], args[3], false));
        if (!index.TryGetFile(args[4].Replace('\\', '/'), out var file) || file is null)
            throw new FileNotFoundException($"Resource not found in index: {args[4]}");
        var content = File.ReadAllBytes(args[5]);
        file.Write(content);
        index.Save();
        return new { ok = true, bytes = content.Length, customBundles = CustomBundles(index) };
    }

    private static object Probe(string[] args)
    {
        if (args.Length < 2) throw new ArgumentException("probe <file> [file...]");
        var locks = new List<FileStream>();
        try
        {
            foreach (var file in args.Skip(1))
                locks.Add(File.Open(Path.GetFullPath(file), FileMode.Open, FileAccess.ReadWrite, FileShare.None));
            return new { ok = true, files = locks.Count };
        }
        finally
        {
            foreach (var stream in locks) stream.Dispose();
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) throw new ArgumentException("Missing command");
            object result = args[0] switch
            {
                "list-custom" => ListCustom(args),
                "resource-bundles" => ResourceBundles(args),
                "extract" => Extract(args),
                "replace" => Replace(args),
                "probe" => Probe(args),
                _ => throw new ArgumentException($"Unknown command: {args[0]}")
            };
            Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
