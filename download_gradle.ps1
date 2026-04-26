# Download Gradle 8.14.3 and place in wrapper cache
# Usage: powershell -ExecutionPolicy Bypass -File download_gradle.ps1

$gradleVersion = "8.14.3"
$url = "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip"
$cacheDir = "$env:USERPROFILE\.gradle\wrapper\dists\gradle-$gradleVersion-bin\cv11ve7ro1n3o1j4so8xd9n66"
$dest = Join-Path $cacheDir "gradle-$gradleVersion-bin.zip"

# Clean up failed downloads
Remove-Item "$dest.part" -ErrorAction SilentlyContinue
Remove-Item "$dest" -ErrorAction SilentlyContinue

Write-Host "Downloading Gradle $gradleVersion (~150MB)..."
Write-Host "From: $url"
Write-Host "To:   $dest"
Write-Host ""

# Use .NET WebClient with increased timeout
$wc = New-Object System.Net.WebClient
try {
    $wc.DownloadFile($url, $dest)
    $size = (Get-Item $dest).Length / 1MB
    Write-Host "Done! File size: $([math]::Round($size, 1)) MB"

    if ($size -lt 100) {
        Write-Host "WARNING: File too small (expected ~150MB). Download may be incomplete."
    } else {
        Write-Host "Gradle downloaded successfully. Now run:"
        Write-Host "  npx expo run:android"
    }
} catch {
    Write-Host "Download failed: $_"
    Write-Host ""
    Write-Host "Try manually with curl:"
    Write-Host "  curl -L -o `"$dest`" `"$url`""
} finally {
    $wc.Dispose()
}
