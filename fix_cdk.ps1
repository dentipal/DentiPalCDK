$filePath = "C:\Users\shashi\Desktop\DentiPalCDK\lib\denti_pal_cdk-stack.ts"
$content = Get-Content $filePath -Raw

$old = @"code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),"@

$new = @"code: lambda.Code.fromAsset(path.join(__dirname, '../lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_18_X.bundlingImage,
          command: [
            'bash', '-c', 
            'npm install && npm run build && cp -r dist/* /asset-output/ && cp -r node_modules /asset-output/'
          ],
        },
      }),"@

$content = $content -replace [regex]::Escape($old), $new
Set-Content $filePath $content
Write-Host "CDK stack updated successfully"
