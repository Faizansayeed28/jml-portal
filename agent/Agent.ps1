#Requires -Modules ActiveDirectory
param([switch]$Loop)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------- SETTINGS: change these ----------
$Config = @{
    TenantId  = "7a2369dd-7d9f-421a-866f-c114c486150a"
    ClientId  = "0e1b82b3-0007-43d3-9c7b-3823ecffc7c8"
    ApiId     = "1e573b37-504d-4a18-8af8-5fca18cbc929"
    ApiUrl    = "https://192.168.186.1:5176"
    TargetOU  = "OU=JML-Test,DC=pwc,DC=local"
    UpnSuffix = "pwc.local"
    LogFile   = "C:\JML\agent.log"
}
# The secret is read from an environment variable, not written in this file
$Secret = $env:JML_AGENT_SECRET
if (-not $Secret -and (Test-Path "C:\JML\secret.bin")) {
    Add-Type -AssemblyName System.Security
    $enc = [IO.File]::ReadAllBytes("C:\JML\secret.bin")
    $Secret = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'LocalMachine'))
}
if (-not $Secret) { throw "No agent secret found. Set JML_AGENT_SECRET or create C:\JML\secret.bin." }
# --------------------------------------------

function Write-Log($msg) {
    $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg
    Write-Host $line
    Add-Content -Path $Config.LogFile -Value $line
}

function Get-ApiToken {
    $body = @{
        grant_type    = "client_credentials"
        client_id     = $Config.ClientId
        client_secret = $Secret
        scope         = "api://$($Config.ApiId)/.default"
    }
    $uri = "https://login.microsoftonline.com/$($Config.TenantId)/oauth2/v2.0/token"
    (Invoke-RestMethod -Method Post -Uri $uri -Body $body).access_token
}

function New-TempPassword {
    $chars = (65..90) + (97..122) + (48..57) | ForEach-Object { [char]$_ }
    $symbols = "!@#$%*-_".ToCharArray()
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $pick = {
        param($set)
        $b = New-Object byte[] 4
        $rng.GetBytes($b)
        $set[[BitConverter]::ToUInt32($b, 0) % $set.Length]
    }
    $pw = @()
    $pw += & $pick ([char[]](65..90))
    $pw += & $pick ([char[]](97..122))
    $pw += & $pick ([char[]](48..57))
    $pw += & $pick $symbols
    1..12 | ForEach-Object { $pw += & $pick ($chars + $symbols) }
    -join ($pw | Sort-Object { Get-Random })
}

function New-SamName($first, $last) {
    $base = ($first.Substring(0, 1) + $last) -replace "[^a-zA-Z0-9]", ""
    $base = $base.ToLower()
    if ($base.Length -gt 18) { $base = $base.Substring(0, 18) }
    $sam = $base
    $n = 1
    while (Get-ADUser -Filter "SamAccountName -eq '$sam'" -ErrorAction SilentlyContinue) {
        $n++
        $sam = "$base$n"
    }
    $sam
}

function Send-Result($headers, $id, $status, $errMsg, $sam = $null, $upn = $null, $pw = $null) {
    $json = @{
        status            = $status
        errorMessage      = $errMsg
        samAccountName    = $sam
        userPrincipalName = $upn
        tempPassword      = $pw
    } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$($Config.ApiUrl)/api/agent/items/$id/result" `
        -Headers $headers -ContentType "application/json" -Body $json | Out-Null
}

function Invoke-OnePass {
    $token = Get-ApiToken
    $headers = @{ Authorization = "Bearer $token" }
    $resp = Invoke-RestMethod -Method Post -Uri "$($Config.ApiUrl)/api/agent/claim" -Headers $headers
    $items = @($resp | ForEach-Object { $_ })

    if ($items.Count -eq 0) { Write-Log "No pending joiners."; return }
    Write-Log "Claimed $($items.Count) joiner(s)."

    foreach ($item in $items) {
        $display = "$($item.firstName) $($item.lastName)"
        try {
            $exists = Get-ADUser -SearchBase $Config.TargetOU -Filter { Name -eq $display } -ErrorAction SilentlyContinue
            if ($exists) { throw "A user named '$display' already exists in the target OU" }

            $sam = New-SamName $item.firstName $item.lastName
            $upn = "$sam@$($Config.UpnSuffix)"
            $pwPlain = New-TempPassword
            $pwSecure = ConvertTo-SecureString $pwPlain -AsPlainText -Force

            $params = @{
                Name                  = $display
                GivenName             = $item.firstName
                Surname               = $item.lastName
                DisplayName           = $display
                SamAccountName        = $sam
                UserPrincipalName     = $upn
                Department            = $item.department
                Title                 = $item.jobTitle
                Path                  = $Config.TargetOU
                AccountPassword       = $pwSecure
                Enabled               = $true
                ChangePasswordAtLogon = $true
            }

            $mgrName = $item.manager
            if ($mgrName) {
                $mgr = Get-ADUser -Filter { Name -eq $mgrName } -ErrorAction SilentlyContinue
                if ($mgr) { $params.Manager = $mgr.DistinguishedName }
                else { Write-Log "Manager '$mgrName' not found for $display (continuing without)." }
            }

            New-ADUser @params
            Write-Log "CREATED $display as $sam."
            Send-Result $headers $item.id "Success" $null $sam $upn $pwPlain
        }
        catch {
            Write-Log "FAILED $display : $($_.Exception.Message)"
            Send-Result $headers $item.id "Failed" $_.Exception.Message
        }
    }
}

if ($Loop) {
    Write-Log "Agent started, waiting for joiners."
    while ($true) {
        try { Invoke-OnePass }
        catch {
            Write-Log "Pass error: $($_.Exception.Message)"
            $script:Token = $null
            Start-Sleep -Seconds 10
        }
    }
}
else {
    Invoke-OnePass
}