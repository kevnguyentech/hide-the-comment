# Packages the extension into a .vsix file, for installing in VS Code or uploading to the Visual
# Studio Marketplace. Needs nothing but PowerShell.
# Run with: powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
$package = [System.IO.File]::ReadAllText((Join-Path $root 'package.json'), $utf8) | ConvertFrom-Json
$vsix = Join-Path $root ('{0}-{1}.vsix' -f $package.name, $package.version)
$repository = $package.repository.url -replace '^git\+', '' -replace '\.git$', ''

function Escape([string]$text) { [System.Security.SecurityElement]::Escape($text) }

# The Marketplace shows the README on its own site, where relative links lead nowhere. Point them
# at the repository instead: images to the raw file, everything else to the file's page.
$readme = [System.IO.File]::ReadAllText((Join-Path $root 'README.md'), $utf8)
$readme = [regex]::Replace($readme, '(!?)\[([^\]]*)\]\((?!https?:|#|mailto:)([^)\s]+)\)', {
  param($match)
  $view = if ($match.Groups[1].Value) { 'raw' } else { 'blob' }
  '{0}[{1}]({2}/{3}/HEAD/{4})' -f $match.Groups[1].Value, $match.Groups[2].Value, $repository, $view, $match.Groups[3].Value
})

# Mirrors the manifest written by vsce, the official packaging tool.
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(Escape $package.name)" Version="$(Escape $package.version)" Publisher="$(Escape $package.publisher)" />
    <DisplayName>$(Escape $package.displayName)</DisplayName>
    <Description xml:space="preserve">$(Escape $package.description)</Description>
    <Tags>$(Escape ($package.keywords -join ','))</Tags>
    <Categories>$(Escape ($package.categories -join ','))</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(Escape $package.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="$(Escape "${repository}.git")" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="$(Escape "${repository}.git")" />
      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="$(Escape "${repository}.git")" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="$(Escape $package.bugs.url)" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="$(Escape $package.homepage)" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
"@

# Every file extension in the package has to be declared here.
$contentTypes = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".txt" ContentType="text/plain" />
</Types>
"@

# Name in the package -> text to write, or the file to copy.
$texts = [ordered]@{
  '[Content_Types].xml'    = $contentTypes
  'extension.vsixmanifest' = $manifest
  'extension/README.md'    = $readme
}
$copies = [ordered]@{
  'extension/package.json' = 'package.json'
  'extension/LICENSE.txt'  = 'LICENSE'
}
foreach ($file in Get-ChildItem (Join-Path $root 'src') -Recurse -File) {
  $relative = $file.FullName.Substring($root.Length + 1)
  # Entry names in a zip use forward slashes; Compress-Archive on Windows PowerShell gets this wrong.
  $copies['extension/' + ($relative -replace '\\', '/')] = $relative
}

if (Test-Path $vsix) { Remove-Item $vsix }
$zip = [System.IO.Compression.ZipFile]::Open($vsix, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($name in $texts.Keys) {
    $writer = New-Object System.IO.StreamWriter($zip.CreateEntry($name).Open(), $utf8)
    $writer.Write($texts[$name])
    $writer.Dispose()
  }
  foreach ($name in $copies.Keys) {
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $copies[$name]), $name)
  }
} finally {
  $zip.Dispose()
}

"Created $vsix"
