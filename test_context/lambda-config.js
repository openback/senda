module.exports = {
    region: 'us-east-1',
    handler: 'index.handler',
    role: 'arn:aws:iam::506512458199:role/lambda_basic_execution',
    timeout: 10,
    memorySize: 128,
    runtime: 'nodejs',
    contextName: 'SisieConfig',
    naming: 'snake'
};
