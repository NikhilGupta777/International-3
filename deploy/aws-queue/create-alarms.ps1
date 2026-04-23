param(
  [string]$Region = "us-east-1",
  [string]$Prefix = "ytgrabber-green",
  [string]$SnsTopicArn = "",
  [string]$AlarmEmail = "",
  [string]$InstanceId = ""
)

$ErrorActionPreference = "Stop"

function Assert-LastExit([string]$Context) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Context failed with exit code $LASTEXITCODE"
  }
}

function Put-Alarm(
  [string]$AlarmName,
  [string]$Namespace,
  [string]$MetricName,
  [string]$Statistic,
  [int]$Period,
  [int]$EvaluationPeriods,
  [double]$Threshold,
  [string]$ComparisonOperator,
  [string]$TreatMissingData,
  [string[]]$Dimensions
) {
  $args = @(
    "cloudwatch", "put-metric-alarm",
    "--region", $Region,
    "--alarm-name", $AlarmName,
    "--namespace", $Namespace,
    "--metric-name", $MetricName,
    "--statistic", $Statistic,
    "--period", "$Period",
    "--evaluation-periods", "$EvaluationPeriods",
    "--threshold", "$Threshold",
    "--comparison-operator", $ComparisonOperator,
    "--treat-missing-data", $TreatMissingData
  )

  foreach ($dim in $Dimensions) {
    $args += @("--dimensions", $dim)
  }

  if ($global:topicArn) {
    $args += @("--alarm-actions", $global:topicArn, "--ok-actions", $global:topicArn)
  }

  aws @args | Out-Null
  Assert-LastExit "Create alarm: $AlarmName"
}

$global:topicArn = $SnsTopicArn
if (-not $global:topicArn -and $AlarmEmail) {
  $topicName = "$Prefix-alerts"
  $global:topicArn = aws sns create-topic `
    --region $Region `
    --name $topicName `
    --query "TopicArn" `
    --output text
  Assert-LastExit "Create SNS topic"

  aws sns subscribe `
    --region $Region `
    --topic-arn $global:topicArn `
    --protocol email `
    --notification-endpoint $AlarmEmail | Out-Null
  Assert-LastExit "Create SNS email subscription"
}

$queueName = "$Prefix-jobs"
$dlqName = "$Prefix-jobs-dlq"
$jobQueueName = "$Prefix-job-queue"

Put-Alarm `
  -AlarmName "$Prefix-queue-depth-high" `
  -Namespace "AWS/SQS" `
  -MetricName "ApproximateNumberOfMessagesVisible" `
  -Statistic "Average" `
  -Period 60 `
  -EvaluationPeriods 5 `
  -Threshold 8 `
  -ComparisonOperator "GreaterThanThreshold" `
  -TreatMissingData "notBreaching" `
  -Dimensions @("Name=QueueName,Value=$queueName")

Put-Alarm `
  -AlarmName "$Prefix-queue-oldest-age-high" `
  -Namespace "AWS/SQS" `
  -MetricName "ApproximateAgeOfOldestMessage" `
  -Statistic "Maximum" `
  -Period 60 `
  -EvaluationPeriods 5 `
  -Threshold 600 `
  -ComparisonOperator "GreaterThanThreshold" `
  -TreatMissingData "notBreaching" `
  -Dimensions @("Name=QueueName,Value=$queueName")

Put-Alarm `
  -AlarmName "$Prefix-dlq-has-messages" `
  -Namespace "AWS/SQS" `
  -MetricName "ApproximateNumberOfMessagesVisible" `
  -Statistic "Average" `
  -Period 60 `
  -EvaluationPeriods 1 `
  -Threshold 0 `
  -ComparisonOperator "GreaterThanThreshold" `
  -TreatMissingData "notBreaching" `
  -Dimensions @("Name=QueueName,Value=$dlqName")

Put-Alarm `
  -AlarmName "$Prefix-batch-failures" `
  -Namespace "AWS/Batch" `
  -MetricName "FailedJobs" `
  -Statistic "Sum" `
  -Period 60 `
  -EvaluationPeriods 1 `
  -Threshold 0 `
  -ComparisonOperator "GreaterThanThreshold" `
  -TreatMissingData "notBreaching" `
  -Dimensions @("Name=JobQueue,Value=$jobQueueName")

if ($InstanceId) {
  Put-Alarm `
    -AlarmName "$Prefix-ec2-cpu-high" `
    -Namespace "AWS/EC2" `
    -MetricName "CPUUtilization" `
    -Statistic "Average" `
    -Period 60 `
    -EvaluationPeriods 10 `
    -Threshold 85 `
    -ComparisonOperator "GreaterThanThreshold" `
    -TreatMissingData "notBreaching" `
    -Dimensions @("Name=InstanceId,Value=$InstanceId")

  Put-Alarm `
    -AlarmName "$Prefix-ec2-status-check-failed" `
    -Namespace "AWS/EC2" `
    -MetricName "StatusCheckFailed" `
    -Statistic "Maximum" `
    -Period 60 `
    -EvaluationPeriods 2 `
    -Threshold 0 `
    -ComparisonOperator "GreaterThanThreshold" `
    -TreatMissingData "notBreaching" `
    -Dimensions @("Name=InstanceId,Value=$InstanceId")
}

Write-Host ""
Write-Host "CloudWatch alarms created/updated for $Prefix in $Region."
if ($global:topicArn) {
  Write-Host "SNS topic: $global:topicArn"
  if ($AlarmEmail) {
    Write-Host "If first-time subscription: confirm the email subscription."
  }
}
