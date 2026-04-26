$ErrorActionPreference = "Continue"
$Region = "us-east-1"
$Prefix = "ytgrabber-green"
$SubnetId = "subnet-0e39d7f64d803f4d6"
$SecurityGroupId = "sg-0dbcfbe5a56de914c"
$ServiceRole = "arn:aws:iam::596596146505:role/ytgrabber-green-batch-service-role"
$AccountId = "596596146505"

# 1. Create Instance Role & Profile
$InstanceRoleName = "$Prefix-ecs-instance-role"
$InstanceProfileName = "$Prefix-ecs-instance-profile"

$assumeRolePolicy = @"
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": { "Service": "ec2.amazonaws.com" },
            "Action": "sts:AssumeRole"
        }
    ]
}
"@
Set-Content -Path ".\assume_policy.json" -Value $assumeRolePolicy

aws iam get-role --role-name $InstanceRoleName 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating IAM role $InstanceRoleName..."
    aws iam create-role --role-name $InstanceRoleName --assume-role-policy-document file://assume_policy.json | Out-Null
    aws iam attach-role-policy --role-name $InstanceRoleName --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
    aws iam attach-role-policy --role-name $InstanceRoleName --policy-arn "arn:aws:iam::aws:policy/AmazonS3FullAccess"
    aws iam attach-role-policy --role-name $InstanceRoleName --policy-arn "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess"
    Start-Sleep -Seconds 5
} else {
    Write-Host "Role $InstanceRoleName already exists."
}

aws iam get-instance-profile --instance-profile-name $InstanceProfileName 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating instance profile $InstanceProfileName..."
    aws iam create-instance-profile --instance-profile-name $InstanceProfileName | Out-Null
    aws iam add-role-to-instance-profile --instance-profile-name $InstanceProfileName --role-name $InstanceRoleName
    Start-Sleep -Seconds 10
} else {
    Write-Host "Instance profile $InstanceProfileName already exists."
}

# 2. Create GPU Compute Environment
$CeName = "$Prefix-gpu-compute"
$ceConfig = @"
{
    "type": "SPOT",
    "allocationStrategy": "SPOT_PRICE_CAPACITY_OPTIMIZED",
    "minvCpus": 0,
    "maxvCpus": 32,
    "desiredvCpus": 0,
    "instanceTypes": ["g4dn.xlarge", "g5.xlarge"],
    "subnets": ["$SubnetId"],
    "securityGroupIds": ["$SecurityGroupId"],
    "instanceRole": "arn:aws:iam::$($AccountId):instance-profile/$InstanceProfileName"
}
"@
Set-Content -Path ".\ce_config.json" -Value $ceConfig

$existingCE = aws batch describe-compute-environments --compute-environments $CeName --region $Region | ConvertFrom-Json
if ($existingCE.computeEnvironments.Count -gt 0) {
    Write-Host "Compute environment $CeName already exists."
} else {
    Write-Host "Creating compute environment $CeName..."
    aws batch create-compute-environment `
        --compute-environment-name $CeName `
        --type MANAGED `
        --state ENABLED `
        --compute-resources file://ce_config.json `
        --service-role $ServiceRole `
        --region $Region | Out-Null
    Start-Sleep -Seconds 10
}

# 3. Create Job Queue
$QueueName = "$Prefix-gpu-queue"
$existingQ = aws batch describe-job-queues --job-queues $QueueName --region $Region | ConvertFrom-Json
if ($existingQ.jobQueues.Count -gt 0) {
    Write-Host "Job queue $QueueName already exists."
} else {
    Write-Host "Creating job queue $QueueName..."
    aws batch create-job-queue `
        --job-queue-name $QueueName `
        --state ENABLED `
        --priority 10 `
        --compute-environment-order computeEnvironment=$CeName,order=1 `
        --region $Region | Out-Null
}

# 4. Create Job Definition for Translator
$JobDefName = "$Prefix-translator-job"
$ExecutionRoleArn = "arn:aws:iam::$($AccountId):role/$Prefix-api-role"
$ImageUri = "$AccountId.dkr.ecr.$Region.amazonaws.com/$Prefix-translator:latest"

$containerProps = @"
{
    "image": "$ImageUri",
    "command": ["python", "worker.py"],
    "jobRoleArn": "$ExecutionRoleArn",
    "executionRoleArn": "$ExecutionRoleArn",
    "resourceRequirements": [
        { "type": "VCPU", "value": "4" },
        { "type": "MEMORY", "value": "15000" },
        { "type": "GPU", "value": "1" }
    ]
}
"@
Set-Content -Path ".\container_props.json" -Value $containerProps

Write-Host "Registering job definition $JobDefName..."
$res = aws batch register-job-definition `
    --job-definition-name $JobDefName `
    --type container `
    --container-properties file://container_props.json `
    --platform-capabilities EC2 `
    --region $Region

$rev = ($res | ConvertFrom-Json).revision
Write-Host "Successfully registered $JobDefName revision $rev"

Remove-Item -ErrorAction SilentlyContinue assume_policy.json, ce_config.json, container_props.json
Write-Host "DONE! AWS Batch GPU resources provisioned."
