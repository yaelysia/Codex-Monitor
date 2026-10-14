param(
    [Parameter(Mandatory=$true)]
    [ValidateRange(1, 2147483647)][int]$RootPid,
    [ValidateRange(0, 60)][int]$Duration = 15
)
$ErrorActionPreference = 'Stop'
# On-demand, read-only Windows process-tree sampling. No process command lines,
# window titles, file paths, conversation data or environment variables are read.
function Take-Snapshot {
    $all = @(Get-CimInstance -ClassName Win32_Process |
        Select-Object ProcessId, ParentProcessId, Name)
    $byParent = @{}
    foreach ($item in $all) {
        $parent = [int]$item.ParentProcessId
        if (-not $byParent.ContainsKey($parent)) {
            $byParent[$parent] = [System.Collections.Generic.List[int]]::new()
        }
        $byParent[$parent].Add([int]$item.ProcessId)
    }
    $queue = [System.Collections.Generic.Queue[int]]::new()
    $seen = [System.Collections.Generic.HashSet[int]]::new()
    $queue.Enqueue($RootPid)
    $records = [System.Collections.Generic.List[object]]::new()
    $workingBytes = [long]0
    $privateBytes = [long]0
    while ($queue.Count -gt 0 -and $seen.Count -lt 80) {
        $id = $queue.Dequeue()
        if (-not $seen.Add($id)) { continue }
        if ($byParent.ContainsKey($id)) {
            foreach ($child in $byParent[$id]) { $queue.Enqueue($child) }
        }
        $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($null -eq $proc) { continue }
        $ws = [long]$proc.WorkingSet64
        $private = [long]$proc.PrivateMemorySize64
        $workingBytes += $ws
        $privateBytes += $private
        $records.Add([pscustomobject]@{
            pid = $id
            name = $proc.ProcessName
            workingMB = [math]::Round($ws / 1MB, 1)
            privateMB = [math]::Round($private / 1MB, 1)
        })
    }
    return [pscustomobject]@{
        processCount = $records.Count
        workingMB = [math]::Round($workingBytes / 1MB, 1)
        privateMB = [math]::Round($privateBytes / 1MB, 1)
        processes = @($records.ToArray() | Sort-Object workingMB -Descending)
    }
}
try {
    if (-not (Get-Process -Id $RootPid -ErrorAction SilentlyContinue)) {
        throw 'The supplied process PID no longer exists'
    }
    $before = Take-Snapshot
    if ($Duration -gt 0) { Start-Sleep -Seconds $Duration }
    $after = Take-Snapshot
    [pscustomobject]@{
        diagnosticVersion = 1
        rootPid = $RootPid
        sampledSeconds = $Duration
        before = $before
        after = $after
        workingDeltaMB = [math]::Round($after.workingMB - $before.workingMB, 1)
        privateDeltaMB = [math]::Round($after.privateMB - $before.privateMB, 1)
    } | ConvertTo-Json -Depth 7
} catch {
    Write-Error 'Memory diagnostic failed (check the provided PID and Windows process-query access)'
    exit 2
}
