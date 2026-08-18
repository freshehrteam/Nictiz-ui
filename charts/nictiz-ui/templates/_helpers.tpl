{{/*
============================================================================
nictiz-ui — template helpers

Label conventions match the health-stack chart deliberately: both releases land
in the same namespace, and `app.kubernetes.io/part-of` is what makes
`kubectl get all -l app.kubernetes.io/part-of=freshehr-open-health-stack` show
the whole system rather than one half of it.
============================================================================
*/}}

{{- define "nictiz-ui.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nictiz-ui.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "nictiz-ui.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nictiz-ui.labels" -}}
helm.sh/chart: {{ include "nictiz-ui.chart" . }}
app.kubernetes.io/name: {{ include "nictiz-ui.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: emr-ui
{{- /* Ties this release to the health-stack it front-ends. */}}
app.kubernetes.io/part-of: freshehr-open-health-stack
{{- end -}}

{{/*
Selector labels — MUST stay stable across upgrades (a Deployment's selector is
immutable, so adding a label here on an existing release fails the upgrade).
Version and chart labels are excluded for exactly that reason.
*/}}
{{- define "nictiz-ui.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nictiz-ui.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Basic-auth Secret name. Falls back to a release-derived name so the annotation
and the rendered Secret can never disagree.
*/}}
{{- define "nictiz-ui.basicAuthSecretName" -}}
{{- .Values.auth.basicAuth.secretName | default (printf "%s-basic-auth" (include "nictiz-ui.fullname" .)) -}}
{{- end -}}
