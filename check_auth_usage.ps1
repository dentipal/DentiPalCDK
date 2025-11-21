# Powershell script to check for extractUserFromBearerToken vs validateToken usage in .ts files
# Targeted specifically at the 'lambda/handlers' directory (adjust path if needed)

# Define the path to your handlers directory relative to where you run this script
$handlersPath = "lambda/handlers" 

# Check if the directory exists before proceeding
if (-not (Test-Path $handlersPath)) {
    Write-Error "Directory '$handlersPath' not found! Please run this script from the root of your project or update the `$handlersPath variable."
    exit
}

# Get all .ts files in the specified directory
$files = Get-ChildItem -Path $handlersPath -Filter "*.ts" -Recurse

$usingExtract = @()
$usingValidate = @()
$usingNeither = @()
$usingBoth = @()

Write-Host "Scanning $($files.Count) TypeScript files in '$handlersPath'..." -ForegroundColor Cyan
Write-Host "------------------------------------------------"

foreach ($file in $files) {
    $content = Get-Content -Path $file.FullName -Raw
    
    # Check for usage (looking for the string in the content)
    # We look for the import or direct usage
    $hasExtract = $content -match "extractUserFromBearerToken"
    $hasValidate = $content -match "validateToken"

    if ($hasExtract -and $hasValidate) {
        $usingBoth += $file.Name
        # We count it in specific lists too for completeness, or you can keep them separate
        $usingExtract += $file.Name
        $usingValidate += $file.Name
    }
    elseif ($hasExtract) {
        $usingExtract += $file.Name
    }
    elseif ($hasValidate) {
        $usingValidate += $file.Name
    }
    else {
        $usingNeither += $file.Name
    }
}

# --- Output Results ---

Write-Host "`n1. Files using 'extractUserFromBearerToken' ($($usingExtract.Count)):" -ForegroundColor Green
if ($usingExtract.Count -eq 0) { Write-Host "   (None)" -ForegroundColor Gray }
else { $usingExtract | Select-Object -Unique | ForEach-Object { Write-Host "   - $_" } }

Write-Host "`n2. Files using 'validateToken' (Deprecated/Legacy) ($($usingValidate.Count)):" -ForegroundColor Yellow
if ($usingValidate.Count -eq 0) {
    Write-Host "   (None - Great job!)" -ForegroundColor Gray
} else {
    $usingValidate | Select-Object -Unique | ForEach-Object { Write-Host "   - $_" }
}

Write-Host "`n3. Files using NEITHER (Public endpoints or Helpers) ($($usingNeither.Count)):" -ForegroundColor Magenta
if ($usingNeither.Count -eq 0) { Write-Host "   (None)" -ForegroundColor Gray }
else { $usingNeither | ForEach-Object { Write-Host "   - $_" } }

if ($usingBoth.Count -gt 0) {
    Write-Host "`n⚠️  WARNING: Files using BOTH (Check for redundancy):" -ForegroundColor Red
    $usingBoth | ForEach-Object { Write-Host "   - $_" }
}

Write-Host "`n------------------------------------------------"
Write-Host "Scan Complete."