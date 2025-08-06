const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

// Define file paths
const templateDir = path.join('templates');
const jsonPath = path.join('test1.json');
// const outputDir = path.join('contracts'); // MOVED: This will be defined dynamically later

// Define all possible templates
const allTemplates = [
  { input: 'Token.sol.hbs', output: 'Token.sol', required: true },
  { input: 'Vesting.sol.hbs', output: 'Vesting.sol', service: 'vesting' },
  { input: 'PoolManager.sol.hbs', output: 'PoolManager.sol', service: ['vesting', 'unlocking', 'pools'] },
  { input: 'IToken.sol.hbs', output: 'IToken.sol', required: true },
  { input: 'Unlocking.sol.hbs', output: 'Unlocking.sol', service: 'unlocking' },
  { input: 'IPoolManager.sol.hbs', output: 'IPoolManager.sol', service: ['vesting', 'unlocking', 'pools'] },
];

// Register the 'eq' helper for Handlebars
Handlebars.registerHelper('eq', function(a, b) {
  return a === b;
});
Handlebars.registerHelper('multiply', function(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') {
    console.warn(`Multiply helper received non-numeric values: a=${a}, b=${b}`);
    return 0;
  }
  return a * b;
})
Handlebars.registerHelper('length', function (object) {
  return Object.keys(object).length;
});

// Read and parse JSON data
let jsonData;
try {
  jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (error) {
  throw new Error(`Failed to read or parse JSON: ${error.message}`);
}

const data = jsonData.initialData || {};
const vestingData = jsonData.vestingAndUnlocking || { tables: { unlocking: { rows: {} }, vesting: { rows: {} } } };
const poolsData = jsonData.pools || { tables: { pools: { rows: {} } } };
const agentsData = jsonData.agents || { rows: {} };
const investmentRoundsData = jsonData.investmentRounds || { rows: {} };
const projectServices = jsonData.projectServices || { serviceTables: { staking: { rows: {} }, farming: { rows: {} } } };

// Validate required fields
if (!data.tokenName || !data.totalTokensAmount) {
  throw new Error('Missing required fields in JSON: tokenName and totalTokensAmount are required');
}


const outputDir = path.join(`Generated_contracts`);

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`Created output directory: ${outputDir}`);
}

// --- CHANGED SECTION END ---


// Helper function to convert rows object to array
const getRowsArray = (rows) => {
  if (!rows || typeof rows !== 'object') return [];
  return Object.values(rows);
};

// Infer active services
const activeServices = [];
const vestingRows = getRowsArray(vestingData.tables.vesting && vestingData.tables.vesting.rows);
const unlockingRows = getRowsArray(vestingData.tables.unlocking && vestingData.tables.unlocking.rows);
const poolRows = getRowsArray(poolsData.tables.pools && poolsData.tables.pools.rows);
const stakingRows = getRowsArray(projectServices.serviceTables.staking && projectServices.serviceTables.staking.rows);
const farmingRows = getRowsArray(projectServices.serviceTables.farming && projectServices.serviceTables.farming.rows);

if (vestingRows.length > 0) {
  activeServices.push('vesting');
}
if (unlockingRows.length > 0) {
  activeServices.push('unlocking');
}
if (poolRows.some(row => row.amount && Number(row.amount) > 0)) {
  activeServices.push('pools');
}
if (stakingRows.length > 0) {
  activeServices.push('staking');
}
if (farmingRows.length > 0) {
  activeServices.push('farming');
}

// Validate service-specific data
if (activeServices.includes('vesting')) {
  if (poolRows.length === 0) {
    throw new Error('Vesting requires pool data');
  }
  if (getRowsArray(agentsData.rows).length === 0) {
    throw new Error('Vesting requires agent data');
  }
}
if (activeServices.includes('unlocking')) {
  const agentRows = getRowsArray(agentsData.rows);
  const investmentRoundRows = getRowsArray(investmentRoundsData.rows);
  if (agentRows.length === 0 && investmentRoundRows.length === 0) {
    throw new Error('Unlocking requires agent or investment round data');
  }
  const validAgents = agentRows.map(row => row.agentName);
  const validInvestmentRounds = investmentRoundRows.map(row => row.source_name);
  const invalidAgents = unlockingRows.filter(row =>
    row.agent_optionType === 'agent' ? !validAgents.includes(row.agent_optionValue) :
    row.agent_optionType === 'investmentRound' ? !validInvestmentRounds.includes(row.agent_optionValue) :
    true
  ).map(row => row.agent_optionValue);
  if (invalidAgents.length) {
    throw new Error(`Invalid agents in unlocking data: ${invalidAgents.join(', ')}`);
  }
}

// Determine which templates to generate
const templatesToGenerate = allTemplates.filter(template => {
  if (template.required) return true;
  if (template.service) {
    if (Array.isArray(template.service)) {
      return template.service.some(s => activeServices.includes(s));
    }
    return activeServices.includes(template.service);
  }
  return false;
});

// Log active and skipped services
console.log(`Active services: ${activeServices.join(', ') || 'none'}`);
const possibleServices = ['vesting', 'unlocking', 'pools', 'staking', 'farming'];
const skippedServices = possibleServices.filter(s => !activeServices.includes(s));
if (skippedServices.length) {
  console.log(`Skipped services (no data): ${skippedServices.join(', ')}`);
}

// Compile and generate contracts
try {
  templatesToGenerate.forEach(({ input, output }) => {
    const templatePath = path.join(templateDir, input);
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found: ${templatePath}`);
    }
    const templateSource = fs.readFileSync(templatePath, 'utf8');
    const template = Handlebars.compile(templateSource);
    const contractCode = template({
      initialData: data,
      vestingAndUnlocking: vestingData,
      pools: poolsData,
      agents: agentsData,
      investmentRounds: investmentRoundsData,
      projectServices,
      hasVesting: activeServices.includes('vesting'),
      hasUnlocking: activeServices.includes('unlocking'),
      hasPools: activeServices.includes('pools'),
      hasStaking: activeServices.includes('staking'),
      hasFarming: activeServices.includes('farming')
    });
    const outputPath = path.join(outputDir, output);
    fs.writeFileSync(outputPath, contractCode, 'utf8');
    console.log(`Contract generated at: ${outputPath}`);
  });
} catch (error) {
  console.error(`Error generating contracts: ${error.message}`);
  process.exit(1);
}

if (templatesToGenerate.length === 2) {
  console.log('Minimal project: Only token contract generated.');
}