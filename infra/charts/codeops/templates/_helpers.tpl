{{- define "codeops.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "codeops.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "codeops.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "codeops.labels" -}}
app.kubernetes.io/name: {{ include "codeops.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: codeops
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "codeops.image" -}}
{{- $repository := required "image repository is required" .repository -}}
{{- $digest := required "immutable image digest is required" .digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}
{{- fail "image digest must be one lowercase sha256 digest" -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end -}}

{{- define "codeops.quickstart.stableSecret" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $key := index . 2 -}}
{{- $length := index . 3 -}}
{{- $existing := lookup "v1" "Secret" $root.Release.Namespace $name -}}
{{- if and $existing $existing.data (hasKey $existing.data $key) -}}
{{- index $existing.data $key | b64dec -}}
{{- else -}}
{{- randAlphaNum $length -}}
{{- end -}}
{{- end -}}

{{- define "codeops.quickstart.runtimeRegistry" -}}
{{- $fullname := include "codeops.fullname" . -}}
{{- $repository := .Values.quickstart.repository -}}
{{- $runtimeRoot := printf "/var/run/secrets/%s-runtime-repositories" $fullname -}}
{{- $entry := dict
  "repository" $repository.identity
  "repositoryUrl" (printf "https://github.com/%s.git" $repository.identity)
  "readTokenFile" (printf "%s/github-read-token" $runtimeRoot)
  "writeTokenFile" (printf "%s/github-write-token" $runtimeRoot) -}}
{{- dict "version" "codeops.repository-registry/v1" "repositories" (list $entry) | toJson -}}
{{- end -}}

{{- define "codeops.quickstart.steeringRegistry" -}}
{{- $fullname := include "codeops.fullname" . -}}
{{- $repository := .Values.quickstart.repository -}}
{{- $runtimeRoot := printf "/var/run/secrets/%s-runtime-repositories" $fullname -}}
{{- $steeringRoot := printf "/var/run/secrets/%s-steering" $fullname -}}
{{- $entry := dict
  "repository" $repository.identity
  "repositoryUrl" (printf "https://github.com/%s.git" $repository.identity)
  "readTokenFile" (printf "%s/github-read-token" $runtimeRoot)
  "writeTokenFile" (printf "%s/github-write-token" $runtimeRoot)
  "githubSteeringTokenFile" (printf "%s/github-steering-token" $steeringRoot) -}}
{{- dict "version" "codeops.repository-registry/v1" "repositories" (list $entry) | toJson -}}
{{- end -}}

{{- define "codeops.quickstart.controllerRegistry" -}}
{{- $fullname := include "codeops.fullname" . -}}
{{- $repository := .Values.quickstart.repository -}}
{{- $runtimeRoot := printf "/var/run/secrets/%s-runtime-repositories" $fullname -}}
{{- $controllerRoot := printf "/var/run/secrets/%s-repositories" $fullname -}}
{{- $steeringRoot := printf "/var/run/secrets/%s-steering" $fullname -}}
{{- $contextRoot := printf "/var/run/secrets/%s-contexts/%s" $fullname $repository.context.directory -}}
{{- $githubReviewerIds := list -}}
{{- range $repository.github.reviewerIds -}}
{{- $githubReviewerIds = append $githubReviewerIds (int64 .) -}}
{{- end -}}
{{- $entry := dict
  "repository" $repository.identity
  "repositoryUrl" (printf "https://github.com/%s.git" $repository.identity)
  "readTokenFile" (printf "%s/github-read-token" $runtimeRoot)
  "writeTokenFile" (printf "%s/github-write-token" $runtimeRoot)
  "githubWebhookSecretFile" (printf "%s/github-webhook-secret" $controllerRoot)
  "githubSteeringTokenFile" (printf "%s/github-steering-token" $steeringRoot)
  "plane" (dict
    "apiOrigin" $repository.plane.apiOrigin
    "workspaceSlug" $repository.plane.workspaceSlug
    "workspaceId" $repository.plane.workspaceId
    "projectId" $repository.plane.projectId
    "apiKeyFile" (printf "%s/plane-api-key" $controllerRoot)
    "webhookSecretFile" (printf "%s/plane-webhook-secret" $controllerRoot)
    "stateIds" $repository.plane.stateIds)
  "policy" (dict
    "githubReviewerIds" $githubReviewerIds
    "planeHumanActorIds" $repository.plane.humanActorIds
    "planePersonas" $repository.plane.personas
    "projectContextRoot" $contextRoot) -}}
{{- dict "version" "codeops.repository-registry/v1" "repositories" (list $entry) | toJson -}}
{{- end -}}

{{- define "codeops.imagePullSecrets" -}}
{{- if and .Values.quickstart.enabled .Values.quickstart.registry.enabled -}}
{{- toYaml (list (dict "name" .Values.quickstart.registry.secretName)) -}}
{{- else -}}
{{- toYaml .Values.imagePullSecrets -}}
{{- end -}}
{{- end -}}
