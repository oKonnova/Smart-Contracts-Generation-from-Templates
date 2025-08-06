const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

// --- CONFIGURATION CONSTANTS ---
const TEMPLATE_DIR = path.join('templates');
const ALL_TEMPLATES = [
  { input: 'Token.sol.hbs', output: 'Token.sol', required: true },
  { input: 'Vesting.sol.hbs', output: 'Vesting.sol', service: 'vesting' },
  { input: 'PoolManager.sol.hbs', output: 'PoolManager.sol', service: ['vesting', 'unlocking', 'pools'] },
  { input: 'IToken.sol.hbs', output: 'IToken.sol', required: true },
  { input: 'Unlocking.sol.hbs', output: 'Unlocking.sol', service: 'unlocking' },
  { input: 'IPoolManager.sol.hbs', output: 'IPoolManager.sol', service: ['vesting', 'unlocking', 'pools'] },
];

// --- HELPER FUNCTIONS ---

/**
 * Registers custom helper functions for Handlebars templates.
 */
function registerHandlebarsHelpers() {
  Handlebars.registerHelper('eq', (a, b) => a === b);
  Handlebars.registerHelper('multiply', (a, b) => {
    if (typeof a !== 'number' || typeof b !== 'number') {
      console.warn(`Multiply helper received non-numeric values: a=${a}, b=${b}`);
      return 0;
    }
    return a * b;
  });
  Handlebars.registerHelper('length', (object) => Object.keys(object).length);
}

/**
 * Safely converts an object of rows into an array of its values.
 * @param {object} rows - The object containing rows.
 * @returns {Array} An array of row values.
 */
const getRowsArray = (rows) => {
  if (!rows || typeof rows !== 'object') return [];
  return Object.values(rows);
};

// --- CORE LOGIC FUNCTIONS ---

/**
 * Loads, parses, and validates the main project data from a JSON file.
 * @param {string} jsonPath - The path to the JSON configuration file.
 * @returns {object} The structured project data.
 */
function loadProjectData(jsonPath) {
  let jsonData;
  try {
    jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read or parse JSON file at ${jsonPath}: ${error.message}`);
  }

  const projectData = {
    initialData: jsonData.initialData || {},
    vestingAndUnlocking: jsonData.vestingAndUnlocking || { tables: { unlocking: { rows: {} }, vesting: { rows: {} } } },
    pools: jsonData.pools || { tables: { pools: { rows: {} } } },
    agents: jsonData.agents || { rows: {} },
    investmentRounds: jsonData.investmentRounds || { rows: {} },
    projectServices: jsonData.projectServices || { serviceTables: { staking: { rows: {} }, farming: { rows: {} } } },
  };

  // Validate required fields
  if (!projectData.initialData.tokenName || !projectData.initialData.totalTokensAmount) {
    throw new Error('Missing required fields in JSON: initialData.tokenName and initialData.totalTokensAmount are required');
  }

  return projectData;
}

/**
 * Determines which services are active based on the presence of data.
 * @param {object} projectData - The complete project data object.
 * @returns {string[]} An array of active service names.
 */
function determineActiveServices(projectData) {
  const activeServices = [];
  if (getRowsArray(projectData.vestingAndUnlocking?.tables?.vesting?.rows).length > 0) activeServices.push('vesting');
  if (getRowsArray(projectData.vestingAndUnlocking?.tables?.unlocking?.rows).length > 0) activeServices.push('unlocking');
  if (getRowsArray(projectData.pools?.tables?.pools?.rows).some(row => row.amount && Number(row.amount) > 0)) activeServices.push('pools');
  if (getRowsArray(projectData.projectServices?.serviceTables?.staking?.rows).length > 0) activeServices.push('staking');
  if (getRowsArray(projectData.projectServices?.serviceTables?.farming?.rows).length > 0) activeServices.push('farming');
  return activeServices;
}

/**
 * Validates data integrity for the currently active services.
 * @param {string[]} activeServices - The list of active services.
 * @param {object} projectData - The complete project data object.
 */
function validateServiceData(activeServices, projectData) {
  if (activeServices.includes('vesting')) {
    if (getRowsArray(projectData.pools?.tables?.pools?.rows).length === 0) throw new Error('Vesting requires pool data');
    if (getRowsArray(projectData.agents?.rows).length === 0) throw new Error('Vesting requires agent data');
  }

  if (activeServices.includes('unlocking')) {
    const agentRows = getRowsArray(projectData.agents.rows);
    const investmentRoundRows = getRowsArray(projectData.investmentRounds.rows);
    if (agentRows.length === 0 && investmentRoundRows.length === 0) {
      throw new Error('Unlocking requires agent or investment round data');
    }
    const validAgents = agentRows.map(row => row.agentName);
    const validInvestmentRounds = investmentRoundRows.map(row => row.source_name);
    const unlockingRows = getRowsArray(projectData.vestingAndUnlocking.tables.unlocking.rows);
    const invalidAgents = unlockingRows.filter(row =>
      row.agent_optionType === 'agent' ? !validAgents.includes(row.agent_optionValue) :
      row.agent_optionType === 'investmentRound' ? !validInvestmentRounds.includes(row.agent_optionValue) :
      true
    ).map(row => row.agent_optionValue);

    if (invalidAgents.length > 0) {
      throw new Error(`Invalid agents in unlocking data: ${invalidAgents.join(', ')}`);
    }
  }
}

/**
 * Compiles and writes all necessary smart contracts to the output directory.
 * @param {object[]} templatesToGenerate - The filtered list of templates to process.
 * @param {object} projectData - The complete data for populating templates.
 * @param {string[]} activeServices - A list of active services.
 * @param {string} outputDir - The directory to save the generated contracts.
 */
function generateContracts(templatesToGenerate, projectData, activeServices, outputDir) {
  console.log('\nGenerating contracts...');
  const templateContext = {
    ...projectData,
    hasVesting: activeServices.includes('vesting'),
    hasUnlocking: activeServices.includes('unlocking'),
    hasPools: activeServices.includes('pools'),
    hasStaking: activeServices.includes('staking'),
    hasFarming: activeServices.includes('farming'),
  };

  templatesToGenerate.forEach(({ input, output }) => {
    const templatePath = path.join(TEMPLATE_DIR, input);
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found: ${templatePath}`);
    }
    const templateSource = fs.readFileSync(templatePath, 'utf8');
    const compiledTemplate = Handlebars.compile(templateSource);
    const contractCode = compiledTemplate(templateContext);
    const outputPath = path.join(outputDir, output);
    fs.writeFileSync(outputPath, contractCode, 'utf8');
    console.log(`  ✓ Generated: ${outputPath}`);
  });
}

// --- MAIN EXECUTION ---

function main() {
  try {
    // 1. Setup
    registerHandlebarsHelpers();
    const jsonPath = path.join('tokenomicsData.json');

    // 2. Load and Validate Data
    const projectData = loadProjectData(jsonPath);
    const activeServices = determineActiveServices(projectData);
    validateServiceData(activeServices, projectData);

    // 3. Determine which templates to use
    const templatesToGenerate = ALL_TEMPLATES.filter(template => {
      if (template.required) return true;
      if (Array.isArray(template.service)) {
        return template.service.some(s => activeServices.includes(s));
      }
      return activeServices.includes(template.service);
    });
    
    // 4. Create output directory
    const outputDir = path.join('generated_contracts');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      console.log(`Created output directory: ${outputDir}`);
    }

    // 5. Log status and generate files
    console.log(`Active services: ${activeServices.join(', ') || 'none'}`);
    generateContracts(templatesToGenerate, projectData, activeServices, outputDir);

    // 6. Final status message
    if (templatesToGenerate.length === 2) {
      console.log('\nMinimal project: Only token contract generated.');
    }
    console.log('\nContract generation process completed successfully!');

  } catch (error) {
    console.error(`\nERROR: ${error.message}`);
    process.exit(1);
  }
}

// Run the script
main();
