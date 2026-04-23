<#
.SYNOPSIS
  Posts randomized DentiPal job postings (temporary, multiday, permanent) for testing.

.EXAMPLE
  .\post-test-jobs.ps1 -AccessToken "eyJ..." -ClinicIds "clinic-1","clinic-2"

.EXAMPLE
  # Dry run, 20 jobs, preview payloads only
  .\post-test-jobs.ps1 -AccessToken "eyJ..." -ClinicIds "c1" -TotalJobs 20 -DryRun
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AccessToken,

    [Parameter(Mandatory = $true)]
    [string[]]$ClinicIds,

    [int]$TotalJobs = 100,

    [string]$BaseUrl = 'https://o21cxsun3k.execute-api.us-east-1.amazonaws.com/prod',

    [switch]$DryRun,

    [string]$OutputCsv = "job-post-results-$(Get-Date -Format 'yyyyMMdd-HHmmss').csv",

    [int]$DelayMilliseconds = 150
)

$ErrorActionPreference = 'Stop'
[System.Net.ServicePointManager]::SecurityProtocol =
    [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12

# --- constants ---------------------------------------------------------------

$AllRoles = @(
    'dentist','associate_dentist','dental_hygienist','dental_assistant',
    'treatment_coordinator_front','billing_coordinator',
    'insurance_verification','patient_coordinator_front'
)
$DoctorRoles    = @('dentist','associate_dentist')
$NonDoctorRoles = $AllRoles | Where-Object { $DoctorRoles -notcontains $_ }

$Specialities    = @('general_dentistry','pediatric_dentistry','orthodontics','endodontics','periodontics')
$PayTypes        = @('per_hour','per_transaction','percentage_of_revenue')
$EmploymentTypes = @('full_time','part_time')
$BenefitsPool    = @('health_insurance','dental_insurance','vision_insurance','paid_time_off',
                     '401k','continuing_education','malpractice_insurance','sick_leave')
$ShiftStarts     = @('08:00','09:00','10:00')
$MealBreaks      = @('00:30','01:00')

# dates: this month (from tomorrow) + next month, all future
$Today          = (Get-Date).Date
$ThisMonthStart = $Today.AddDays(1)
$FirstOfMonth   = Get-Date -Year $Today.Year -Month $Today.Month -Day 1
$NextMonthStart = $FirstOfMonth.AddMonths(1)
$NextMonthEnd   = $NextMonthStart.AddMonths(1).AddDays(-1)

$CandidateDates = @()
for ($d = $ThisMonthStart; $d -le $NextMonthEnd; $d = $d.AddDays(1)) {
    $CandidateDates += $d
}

# --- helpers -----------------------------------------------------------------

function Get-RandomItem { param($Items) return $Items[(Get-Random -Maximum $Items.Count)] }

function Get-RandomRole {
    param([string]$PayType)
    if ($PayType -eq 'per_transaction') { return Get-RandomItem $NonDoctorRoles }
    return Get-RandomItem $AllRoles
}

function Get-Rate {
    param([string]$PayType, [string]$JobType)
    switch ($PayType) {
        'per_hour' {
            if ($JobType -eq 'multiday') { return Get-Random -Minimum 30 -Maximum 250 }
            return Get-Random -Minimum 25 -Maximum 150
        }
        'per_transaction'       { return Get-Random -Minimum 50 -Maximum 200 }
        'percentage_of_revenue' { return Get-Random -Minimum 10 -Maximum 40  }
    }
}

function Get-ShiftTimes {
    param([int]$Hours)
    $start = Get-RandomItem $ShiftStarts
    $startDt = [datetime]::ParseExact($start, 'HH:mm', $null)
    $end = $startDt.AddHours($Hours).ToString('HH:mm')
    return @{ start = $start; end = $end }
}

function Get-RandomBenefits {
    $n = Get-Random -Minimum 2 -Maximum 6
    return @($BenefitsPool | Get-Random -Count $n)
}

function Format-IsoDate { param([datetime]$d) return $d.ToString('yyyy-MM-dd') }

$script:ClinicIndex = 0
function Get-NextClinicIds {
    $id = $ClinicIds[$script:ClinicIndex % $ClinicIds.Count]
    $script:ClinicIndex++
    return ,@($id)
}

# --- payload builders --------------------------------------------------------

function New-TemporaryPayload {
    param([int]$Seq)
    $payType = Get-RandomItem $PayTypes
    $role    = Get-RandomRole -PayType $payType
    $hours   = Get-Random -Minimum 4 -Maximum 11
    $shift   = Get-ShiftTimes -Hours $hours
    $date    = Get-RandomItem $CandidateDates

    return @{
        clinicIds          = Get-NextClinicIds
        job_type           = 'temporary'
        professional_role  = $role
        date               = Format-IsoDate $date
        shift_speciality   = Get-RandomItem $Specialities
        hours              = $hours
        start_time         = $shift.start
        end_time           = $shift.end
        rate               = Get-Rate -PayType $payType -JobType 'temporary'
        pay_type           = $payType
        job_title          = "[TEST] Temp $role #$Seq"
        job_description    = "Auto-generated test temporary posting for $role."
        work_location_type = 'onsite'
        meal_break         = Get-RandomItem $MealBreaks
    }
}

function New-MultidayPayload {
    param([int]$Seq)
    $payType   = Get-RandomItem $PayTypes
    $role      = Get-RandomRole -PayType $payType
    $hours     = Get-Random -Minimum 6 -Maximum 11
    $shift     = Get-ShiftTimes -Hours $hours
    $totalDays = Get-Random -Minimum 2 -Maximum 11
    $startIdx  = Get-Random -Maximum ($CandidateDates.Count - $totalDays)
    $dates = @()
    for ($i = 0; $i -lt $totalDays; $i++) {
        $dates += Format-IsoDate $CandidateDates[$startIdx + $i]
    }

    return @{
        clinicIds          = Get-NextClinicIds
        job_type           = 'multi_day_consulting'
        professional_role  = $role
        dates              = $dates
        total_days         = $totalDays
        shift_speciality   = Get-RandomItem $Specialities
        hours_per_day      = $hours
        start_time         = $shift.start
        end_time           = $shift.end
        rate               = Get-Rate -PayType $payType -JobType 'multiday'
        pay_type           = $payType
        job_title          = "[TEST] Consulting $role #$Seq"
        job_description    = "Auto-generated test multiday consulting posting for $role."
        work_location_type = 'onsite'
        meal_break         = Get-RandomItem $MealBreaks
        project_duration   = "$totalDays days"
    }
}

function New-PermanentPayload {
    param([int]$Seq)
    $role       = Get-RandomItem $AllRoles
    $employment = Get-RandomItem $EmploymentTypes
    $salaryMin  = Get-Random -Minimum 60000 -Maximum 130000
    $salaryMax  = $salaryMin + (Get-Random -Minimum 10000 -Maximum 60000)
    $startDate  = @($CandidateDates | Where-Object { $_ -ge $NextMonthStart }) | Get-Random

    return @{
        clinicIds          = Get-NextClinicIds
        job_type           = 'permanent'
        professional_role  = $role
        shift_speciality   = Get-RandomItem $Specialities
        employment_type    = $employment
        benefits           = Get-RandomBenefits
        salary_min         = $salaryMin
        salary_max         = $salaryMax
        vacation_days      = Get-Random -Minimum 5 -Maximum 26
        start_date         = Format-IsoDate $startDate
        work_location_type = 'onsite'
        job_title          = "[TEST] Permanent $role #$Seq"
        job_description    = "Auto-generated test permanent posting for $role."
    }
}

# --- posting -----------------------------------------------------------------

function Invoke-JobPost {
    param([string]$Path, [hashtable]$Body)
    $url = "$BaseUrl$Path"
    $headers = @{
        'Authorization' = "Bearer $AccessToken"
        'Content-Type'  = 'application/json'
    }
    $json = $Body | ConvertTo-Json -Depth 10 -Compress

    if ($DryRun) {
        Write-Host "[DRY] POST $url" -ForegroundColor DarkGray
        Write-Host "       $json"    -ForegroundColor DarkGray
        return [pscustomobject]@{ ok = $true; status = 'DRY'; id = $null; error = $null }
    }

    try {
        $resp = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -Body $json
        $id = $null
        if     ($resp.data.jobIds) { $id = ($resp.data.jobIds -join ',') }
        elseif ($resp.data.jobId)  { $id = $resp.data.jobId }
        elseif ($resp.jobIds)      { $id = ($resp.jobIds -join ',') }
        elseif ($resp.jobId)       { $id = $resp.jobId }
        elseif ($resp.id)          { $id = $resp.id }
        return [pscustomobject]@{ ok = $true; status = 200; id = $id; error = $null }
    }
    catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        $msg = $_.Exception.Message
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $msg = $_.ErrorDetails.Message
        }
        elseif ($_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                if ($stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    $msg = $reader.ReadToEnd()
                }
            } catch {}
        }
        return [pscustomobject]@{ ok = $false; status = $status; id = $null; error = $msg }
    }
}

# --- distribute job types ----------------------------------------------------

$temp  = [int][math]::Ceiling($TotalJobs / 3.0)
$multi = [int][math]::Ceiling(($TotalJobs - $temp) / 2.0)
$perm  = $TotalJobs - $temp - $multi

$TypeSequence = @()
for ($i = 0; $i -lt $temp;  $i++) { $TypeSequence += 'temporary' }
for ($i = 0; $i -lt $multi; $i++) { $TypeSequence += 'multiday' }
for ($i = 0; $i -lt $perm;  $i++) { $TypeSequence += 'permanent' }
$TypeSequence = $TypeSequence | Sort-Object { Get-Random }

Write-Host "Posting $TotalJobs jobs to $BaseUrl" -ForegroundColor Cyan
Write-Host "  Temporary: $temp   Multiday: $multi   Permanent: $perm" -ForegroundColor Cyan
Write-Host "  Clinic IDs (round-robin): $($ClinicIds -join ', ')" -ForegroundColor Cyan
if ($DryRun) { Write-Host "  [DRY RUN - no requests will be sent]" -ForegroundColor Yellow }

# --- main loop ---------------------------------------------------------------

$results = New-Object System.Collections.Generic.List[object]

for ($i = 0; $i -lt $TypeSequence.Count; $i++) {
    $type = $TypeSequence[$i]
    switch ($type) {
        'temporary' { $payload = New-TemporaryPayload -Seq ($i + 1); $path = '/jobs/temporary' }
        'multiday'  { $payload = New-MultidayPayload  -Seq ($i + 1); $path = '/jobs/consulting' }
        'permanent' { $payload = New-PermanentPayload -Seq ($i + 1); $path = '/jobs/permanent'  }
    }

    $r = Invoke-JobPost -Path $path -Body $payload

    $dateLabel = switch ($type) {
        'temporary' { $payload.date }
        'multiday'  { ($payload.dates[0]) + '..' + ($payload.dates[$payload.dates.Count - 1]) }
        'permanent' { $payload.start_date }
    }

    $row = [pscustomobject]@{
        seq      = $i + 1
        type     = $type
        pay_type = $payload.pay_type
        role     = $payload.professional_role
        date     = $dateLabel
        clinicId = $payload.clinicIds[0]
        ok       = $r.ok
        status   = $r.status
        jobId    = $r.id
        error    = $r.error
    }
    $results.Add($row) | Out-Null

    $color = if ($r.ok) { 'Green' } else { 'Red' }
    Write-Host ("  [{0,3}] {1,-9} {2,-28} {3,-22} {4,-22} status={5} id={6}" -f `
        ($i + 1), $type, $payload.professional_role, $payload.pay_type, $dateLabel, $r.status, $r.id) `
        -ForegroundColor $color
    if (-not $r.ok -and $r.error) { Write-Host ("        ! " + $r.error) -ForegroundColor DarkRed }

    if (-not $DryRun -and $DelayMilliseconds -gt 0) { Start-Sleep -Milliseconds $DelayMilliseconds }
}

# --- summary -----------------------------------------------------------------

$ok   = ($results | Where-Object { $_.ok }).Count
$fail = $results.Count - $ok

Write-Host ""
Write-Host "===== Summary =====" -ForegroundColor Cyan
Write-Host "  Total: $($results.Count)"
Write-Host "  OK:    $ok"   -ForegroundColor Green
Write-Host "  Fail:  $fail" -ForegroundColor Red
$results | Group-Object type     | ForEach-Object { Write-Host ("  by type     {0,-12} {1}" -f $_.Name, $_.Count) }
$results | Group-Object pay_type | ForEach-Object { Write-Host ("  by pay_type {0,-22} {1}" -f $_.Name, $_.Count) }

if (-not $DryRun) {
    $results | Export-Csv -NoTypeInformation -Path $OutputCsv
    Write-Host "Results written to $OutputCsv" -ForegroundColor Cyan
}
