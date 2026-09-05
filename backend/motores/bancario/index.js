/**
 * Facade oficial do Motor Bancário (MBC-01 — fundação).
 * @module motores/bancario
 */
'use strict';

const MotorBancarioService = require('./MotorBancarioService');
const constantes = require('./contracts/constantes');
const dto = require('./contracts/TransacaoBancariaNormalizada');
const { IBankProvider } = require('./contracts/IBankProvider');
const contexto = require('./BancarioEmpresaContextoService');
const VERSAO = require('./version');
const schema = require('./schema/bancarioSchema');
const InstituicaoFinanceiraService = require('./services/InstituicaoFinanceiraService');
const ContaBancariaService = require('./services/ContaBancariaService');
const TransacaoBancariaService = require('./services/TransacaoBancariaService');
const ConciliacaoBancariaService = require('./services/ConciliacaoBancariaService');
const ConfiguracaoIntegracaoBancariaService = require('./services/ConfiguracaoIntegracaoBancariaService');
const ConsentimentoOpenFinanceService = require('./services/ConsentimentoOpenFinanceService');
const SincronizacaoBancariaService = require('./services/SincronizacaoBancariaService');
const MotorMatchingBancarioService = require('./matching/MotorMatchingBancarioService');
const { BankProviderRegistry, obterRegistryPadrao, criarRegistryPadrao } = require('./providers/BankProviderRegistry');
const { MockBankProvider } = require('./providers/MockBankProvider');
const { MockOpenFinanceProvider } = require('./providers/MockOpenFinanceProvider');
const { OpenFinanceRealBankProvider } = require('./providers/openfinance-real/OpenFinanceRealBankProvider');
const ambienteEndpoints = require('./providers/openfinance-real/ambienteEndpoints');
const prontidaoOperacaoReal = require('./providers/openfinance-real/prontidaoOperacaoReal');
const operacaoAssistida = require('./providers/openfinance-real/operacaoAssistida');
const rateLimitProvider = require('./providers/openfinance-real/rateLimitProvider');
const rollbackOperacaoReal = require('./providers/openfinance-real/rollbackOperacaoReal');
const auditoriaProntidao = require('./providers/openfinance-real/auditoriaProntidao');
const { adaptarTransacaoDoProvider, adaptarPaginaDoProvider } = require('./providers/adaptarTransacaoProvider');
const { montarEventoOperacaoMbc, registrarOperacaoMbc } = require('./contracts/observabilidadeMbc');
const { MemorySecretStore } = require('./secrets/MemorySecretStore');
const { EncryptedLocalSecretStore, obterSecretStore } = require('./secrets/EncryptedLocalSecretStore');

module.exports = {
  ...MotorBancarioService,
  ...constantes,
  ...dto,
  ...contexto,
  IBankProvider,
  VERSAO,
  ...schema,
  InstituicaoFinanceiraService,
  ContaBancariaService,
  TransacaoBancariaService,
  ConciliacaoBancariaService,
  ConfiguracaoIntegracaoBancariaService,
  ConsentimentoOpenFinanceService,
  SincronizacaoBancariaService,
  MotorMatchingBancarioService,
  BankProviderRegistry,
  obterRegistryPadrao,
  criarRegistryPadrao,
  MockBankProvider,
  MockOpenFinanceProvider,
  OpenFinanceRealBankProvider,
  ambienteEndpoints,
  prontidaoOperacaoReal,
  operacaoAssistida,
  rateLimitProvider,
  rollbackOperacaoReal,
  auditoriaProntidao,
  adaptarTransacaoDoProvider,
  adaptarPaginaDoProvider,
  montarEventoOperacaoMbc,
  registrarOperacaoMbc,
  MemorySecretStore,
  EncryptedLocalSecretStore,
  obterSecretStore
};
