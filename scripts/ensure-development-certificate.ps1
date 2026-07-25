[CmdletBinding()]
param(
  [string]$Subject = 'CN=FreeCut Development'
)

$ErrorActionPreference = 'Stop'
$minimumValidity = (Get-Date).AddDays(30)

$personalStore = [System.Security.Cryptography.X509Certificates.X509Store]::new(
  [System.Security.Cryptography.X509Certificates.StoreName]::My,
  [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
)
$personalStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
try {
  $certificate = $personalStore.Certificates |
    Where-Object {
      $_.Subject -eq $Subject -and
      $_.HasPrivateKey -and
      $_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3' -and
      $_.NotAfter -gt $minimumValidity
    } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

  if (-not $certificate) {
    $rsa = [System.Security.Cryptography.RSA]::Create(3072)
    try {
      $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        $Subject,
        $rsa,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
      )
      $request.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
          $false,
          $false,
          0,
          $true
        )
      )
      $request.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
          [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
          $true
        )
      )
      $codeSigningOids =
        [System.Security.Cryptography.OidCollection]::new()
      $null = $codeSigningOids.Add(
        [System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3', 'Code Signing')
      )
      $request.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new(
          $codeSigningOids,
          $true
        )
      )

      $temporaryCertificate = $request.CreateSelfSigned(
        (Get-Date).AddDays(-2),
        (Get-Date).AddYears(3)
      )
      try {
        $randomBytes = New-Object byte[] 32
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
          $random.GetBytes($randomBytes)
        } finally {
          $random.Dispose()
        }
        $password = [Convert]::ToBase64String($randomBytes)
        $pfx = $temporaryCertificate.Export(
          [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
          $password
        )
        $keyStorageFlags =
          [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet -bor
          [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet
        $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
          $pfx,
          $password,
          $keyStorageFlags
        )
        $certificate.FriendlyName = 'FreeCut Development Code Signing'
        $personalStore.Add($certificate)
      } finally {
        $temporaryCertificate.Dispose()
      }
    } finally {
      $rsa.Dispose()
    }
  }
} finally {
  $personalStore.Close()
}

Write-Output "FreeCut development certificate: $($certificate.Subject)"
Write-Output "Thumbprint: $($certificate.Thumbprint)"
Write-Output "Expires: $($certificate.NotAfter.ToString('u'))"
Write-Output 'Trust: self-signed certificate is not installed as a trusted root'
