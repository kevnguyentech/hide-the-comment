# Packages the extension into a .vsix file that VS Code can install. Needs nothing but PowerShell.
# Run with: powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$package = Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json
$vsix = Join-Path $root ('{0}-{1}.vsix' -f $package.name, $package.version)

$files = @('package.json', 'README.md')
# The images are the ones the README shows.
foreach ($folder in 'src', 'images') {
  $files += Get-ChildItem (Join-Path $root $folder) -Recurse -File | ForEach-Object { $_.FullName.Substring($root.Length + 1) }
}

function Escape([string]$text) { [System.Security.SecurityElement]::Escape($text) }

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(Escape $package.name)" Version="$(Escape $package.version)" Publisher="$(Escape $package.publisher)" />
    <DisplayName>$(Escape $package.displayName)</DisplayName>
    <Description xml:space="preserve">$(Escape $package.description)</Description>
    <Categories>$(Escape ($package.categories -join ','))</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(Escape $package.engines.vscode)" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
"@

$contentTypes = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".png" ContentType="image/png" />
</Types>
"@

if (Test-Path $vsix) { Remove-Item $vsix }
$zip = [System.IO.Compression.ZipFile]::Open($vsix, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  foreach ($entry in @(@('[Content_Types].xml', $contentTypes), @('extension.vsixmanifest', $manifest))) {
    $writer = New-Object System.IO.StreamWriter($zip.CreateEntry($entry[0]).Open(), $utf8)
    $writer.Write($entry[1])
    $writer.Dispose()
  }
  foreach ($file in $files) {
    # Entry names in a zip use forward slashes; Compress-Archive on Windows PowerShell gets this wrong.
    $name = 'extension/' + ($file -replace '\\', '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $file), $name)
  }
} finally {
  $zip.Dispose()
}

"Created $vsix"
