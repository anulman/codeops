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

{{- define "codeops.runtimeImagesConfigMapName" -}}
{{- $worker := include "codeops.image" .Values.runtime.workerImage -}}
{{- $agent := include "codeops.image" .Values.runtime.agentImage -}}
{{- $gateway := include "codeops.image" .Values.runtime.sessionGatewayImage -}}
{{- $release := required "runtime release digest is required" .Values.runtime.releaseDigest -}}
{{- $identity := printf "%s\n%s\n%s\n%s\n%s\n%s" $worker $agent $gateway .Values.runtime.profileId $release .Values.runtime.compatibilityPolicyRevision -}}
{{- $prefix := include "codeops.fullname" . | trunc 35 | trimSuffix "-" -}}
{{- printf "%s-runtime-images-%s" $prefix ($identity | sha256sum | trunc 12) -}}
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
{{- $steeringRoot := $controllerRoot -}}
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

{{- define "codeops.imagePullSecretsJson" -}}
{{- if and .Values.quickstart.enabled .Values.quickstart.registry.enabled -}}
{{- toJson (list (dict "name" .Values.quickstart.registry.secretName)) -}}
{{- else -}}
{{- toJson .Values.imagePullSecrets -}}
{{- end -}}
{{- end -}}

{{- define "codeops.runtimeEgressProxyConfig" -}}
http_port 3128
max_filedescriptors 1024

acl runtime_clients src 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
acl safe_ports port{{ range .Values.runtimeEgressProxy.allowedConnectPorts }} {{ . }}{{ end }}{{ if .Values.runtimeEgressProxy.allowPlainHttp }} 80{{ end }}
acl tls_ports port{{ range .Values.runtimeEgressProxy.allowedConnectPorts }} {{ . }}{{ end }}
acl connect method CONNECT
acl allowed_domains dstdomain{{ range .Values.runtimeEgressProxy.allowedDomains }} {{ . }}{{ end }}
acl forbidden_destinations dst 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4

http_access deny !safe_ports
http_access deny connect !tls_ports
http_access deny forbidden_destinations
http_access allow runtime_clients allowed_domains
http_access deny all

cache deny all
cache_mem 32 MB
maximum_object_size_in_memory 512 KB
workers 1
pinger_enable off
forwarded_for delete
request_header_access X-Forwarded-For deny all
request_header_access Via deny all

logformat codeops_json {"timestamp":"%ts.%03tu","clientPodIp":"%>a","method":"%".16rm","destination":"%".320>rd:%>rP","result":"%Ss","upstreamStatus":%>Hs,"bytes":%<st,"durationMs":%tr}
access_log stdio:/var/log/squid/access.log codeops_json
cache_log stdio:/var/log/squid/cache.log
pid_filename none
coredump_dir /tmp
{{- end -}}

{{- define "codeops.postgresqlEgressTarget" -}}
{{- if eq .Values.postgresql.deployment "managed" -}}
podSelector:
  matchLabels: { app.kubernetes.io/name: {{ include "codeops.fullname" . }}-postgresql }
{{- else -}}
namespaceSelector:
  matchLabels: { kubernetes.io/metadata.name: {{ .Values.postgresql.external.namespace }} }
{{- with .Values.postgresql.external.podSelector }}
podSelector:
  matchLabels:
    {{- toYaml . | nindent 4 }}
{{- end }}
{{- end -}}
{{- end -}}

{{- define "codeops.jetstreamEgressTarget" -}}
{{- if eq .Values.jetstream.deployment "managed" -}}
podSelector:
  matchLabels: { app.kubernetes.io/instance: {{ .Release.Name }} }
{{- else -}}
namespaceSelector:
  matchLabels: { kubernetes.io/metadata.name: {{ .Values.jetstream.external.namespace }} }
{{- end -}}
{{- end -}}
