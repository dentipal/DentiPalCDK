import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DentiPalCDKStack } from '../lib/denti_pal_cdk-stack';

const app = new cdk.App();
new DentiPalCDKStack(app, 'DentiPalCDKStackV5', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});