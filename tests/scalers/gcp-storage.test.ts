import * as fs from 'fs'
import * as sh from 'shelljs'
import * as tmp from 'tmp'
import test from 'ava'

const testNamespace = 'gcp-storage-test'
const bucketName = 'keda-test-storage-bucket'
const deploymentName = 'dummy-consumer'
const maxReplicaCount = '3'
const gsPrefix = `kubectl exec --namespace ${testNamespace} deploy/gcp-sdk -- `
const gcpKey = process.env['GCP_SP_KEY']

test.before(t => {
    sh.exec(`kubectl create namespace ${testNamespace}`)

    // deploy dummy consumer app, scaled object etc.
    const tmpFile = tmp.fileSync()
    fs.writeFileSync(tmpFile.name, deployYaml.replace("{{GCP_CREDS}}", Buffer.from(gcpKey).toString("base64")))

    t.is(
        0,
        sh.exec(`kubectl apply -f ${tmpFile.name} --namespace ${testNamespace}`).code,
        'creating a deployment should work..'
    )

})

test.serial('Deployment should have 0 replicas on start', t => {
    const replicaCount = sh.exec(
        `kubectl get deployment.apps/${deploymentName} --namespace ${testNamespace} -o jsonpath="{.spec.replicas}"`
    ).stdout
    t.is(replicaCount, '0', 'replica count should start out as 0')
})

test.serial('creating the gcp-sdk pod should work..', t => {
    let tmpFile = tmp.fileSync()
    fs.writeFileSync(tmpFile.name, gcpSdkYaml)
    t.is(
        0,
        sh.exec(`kubectl apply -f ${tmpFile.name} --namespace ${testNamespace}`).code,
        'creating the gcp-sdk pod should work..'
    )

    // wait for the gcp-sdkpod to be ready
    let gcpSdkReadyReplicaCount = '0'
    for (let i = 0; i < 30; i++) {
        gcpSdkReadyReplicaCount = sh.exec(`kubectl get deploy/gcp-sdk -n ${testNamespace} -o jsonpath='{.status.readyReplicas}'`).stdout
        if (gcpSdkReadyReplicaCount != '1') {
            sh.exec('sleep 2s')
        }
    }
    t.is('1', gcpSdkReadyReplicaCount, 'GCP-SDK pod is not in a ready state')
})

test.serial('initializing the gcp-sdk pod should work..', t => {
    // Authenticate to GCP
    t.is(
        0,
        sh.exec(gsPrefix + `gcloud auth activate-service-account --key-file /etc/secret-volume/GOOGLE_APPLICATION_CREDENTIALS_JSON`).code,
        'Executing remote command on gcp-sdk should work..'
    )

    const creds = JSON.parse(gcpKey)

    // Set project id
    sh.exec(gsPrefix + `gcloud config set project ${creds.project_id}`)

    // Cleanup the bucket
    sh.exec(gsPrefix + `gsutil -m rm -r gs://${bucketName}`)

    // Create bucket
    sh.exec(gsPrefix + `gsutil mb gs://${bucketName}`)
})

test.serial(`Uploading objects to GCS bucket`, t => {
    for (let i = 0; i < 30; i++) {
      t.is(
          0,
          sh.exec(gsPrefix + `gsutil cp -n /usr/lib/google-cloud-sdk/bin/gsutil gs://${bucketName}/gsutil` + i).code,
          'Copying an object should work..'
      )
    }
})

test.serial(`Deployment should scale to ${maxReplicaCount} (the max) then back to 0`, t => {
    let replicaCount = '0'

    // Wait for the number of replicas to be scaled up to maxReplicaCount
    for (let i = 0; i < 60 && replicaCount != maxReplicaCount; i++) {
        replicaCount = sh.exec(
            `kubectl get deployment.apps/${deploymentName} --namespace ${testNamespace} -o jsonpath="{.spec.replicas}"`
        ).stdout
        if (replicaCount != maxReplicaCount) {
            sh.exec('sleep 2s')
        }
    }

    t.is(maxReplicaCount, replicaCount, `Replica count should be ${maxReplicaCount} after 120 seconds but is ${replicaCount}`)
})

test.serial(`Deleting objects from GCS bucket`, t => {
    t.is(
        0,
        sh.exec(gsPrefix + `gsutil -m rm -a gs://${bucketName}/**`).code,
        'Deleting objects should work..'
    )
})

test.serial(`Deployment should scale back to 0`, t => {
    let replicaCount = maxReplicaCount

    // Wait for the number of replicas to be scaled down to 0
    for (let i = 0; i < 30 && replicaCount !== '0'; i++) {
      replicaCount = sh.exec(
        `kubectl get deployment.apps/${deploymentName} --namespace ${testNamespace} -o jsonpath="{.spec.replicas}"`
      ).stdout
      if (replicaCount != '0') {
        sh.exec('sleep 10s')
      }
    }

    t.is('0', replicaCount, 'Replica count should be 0 after 5 minutes')
})

test.after.always.cb('clean up', t => {
    // Cleanup the bucket
    sh.exec(gsPrefix + `gsutil -m rm -r gs://${bucketName}`)

    sh.exec(`kubectl delete deployment.apps/${deploymentName} --namespace ${testNamespace}`)
    sh.exec(`kubectl delete namespace ${testNamespace}`)

    t.end()
})


const deployYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deploymentName}
  namespace: ${testNamespace}
  labels:
    app: ${deploymentName}
spec:
  replicas: 0
  selector:
    matchLabels:
      app: ${deploymentName}
  template:
    metadata:
      labels:
        app: ${deploymentName}
    spec:
      containers:
        - name: noop-processor
          image: ubuntu:20.04
          command: ["/bin/bash", "-c", "--"]
          args: ["sleep 10"]
          env:
            - name: GOOGLE_APPLICATION_CREDENTIALS_JSON
              valueFrom:
                secretKeyRef:
                  name: gcp-storage-secrets
                  key: GOOGLE_APPLICATION_CREDENTIALS_JSON
---
apiVersion: v1
kind: Secret
metadata:
  name: gcp-storage-secrets
type: Opaque
data:
  GOOGLE_APPLICATION_CREDENTIALS_JSON: {{GCP_CREDS}}
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: test-scaledobject
spec:
  scaleTargetRef:
    name: ${deploymentName}
  pollingInterval: 5
  maxReplicaCount: ${maxReplicaCount}
  cooldownPeriod: 10
  triggers:
    - type: gcp-storage
      metadata:
        bucketName: ${bucketName}
        targetObjectCount: '5'
        credentialsFromEnv: GOOGLE_APPLICATION_CREDENTIALS_JSON
`

const gcpSdkYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: gcp-sdk
  namespace: ${testNamespace}
  labels:
    app: gcp-sdk
spec:
  replicas: 1
  selector:
    matchLabels:
      app: gcp-sdk
  template:
    metadata:
      labels:
        app: gcp-sdk
    spec:
      containers:
        - name: gcp-sdk-container
          image: google/cloud-sdk:slim
          # Just spin & wait forever
          command: [ "/bin/bash", "-c", "--" ]
          args: [ "ls /tmp && while true; do sleep 30; done;" ]
          volumeMounts:
            - name: secret-volume
              mountPath: /etc/secret-volume
      volumes:
        - name: secret-volume
          secret:
            secretName: gcp-storage-secrets
`
