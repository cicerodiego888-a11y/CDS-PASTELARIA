/**
 * Classificação estática das suítes da Central e fiscais (somente leitura de fonte).
 * Não executa testes e não carrega database.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR_CENTRAL = path.join(__dirname, '..');
const DIR_FISCAL = path.join(__dirname, '../../fiscal');
const REPO_ROOT = path.join(__dirname, '../../..');

const RISCO_EAGER = [
  /database(?:\.js)?$/,
  /DfeAuditoriaService/,
  /CentralDiagnosticoService/,
  /distribuicaoDFe$/,
  /distribuicaoDfeRuntime/,
  /distribuicaoDfeLegado/,
  /CentralSincronizacaoService/,
  /FiscalSoapTelemetry/,
  /fiscal\/core$/,
  /SoapTransport/,
  /configService$/,
  /certificateService/,
  /cancelarNfce$/,
  /emissor$/,
  /(?:^|\/)sqlite3$/
];

const RISCO_LAZY = [
  /CentralEntradasService/,
  /CentralEntradasOrchestrator/,
  /CentralDocumentosRepository/,
  /CentralNsuRepository/,
  /CentralDfePersistenciaService/,
  /CentralManifestacaoDfeService/,
  /MotorRecuperacaoXmlService/,
  /CentralConfiguracaoService/,
  /HealthRepository/,
  /dbHelpers/,
  /EmpresaService/,
  /empresasSchema/,
  /empresasConfiguracaoFiscal/
];

function indicePrimeiroRequire(src, regexes) {
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/gs;
  let min = -1;
  let m;
  while ((m = re.exec(src))) {
    const alvo = m[1].replace(/\\/g, '/');
    if (regexes.some((rx) => rx.test(alvo))) {
      if (min < 0 || m.index < min) min = m.index;
    }
  }
  return min;
}

function classificarFonte(src, rel) {
  const iHelper = src.search(/isolarBancoTeste\s*\(/);
  const iStub = src.search(/require\.cache\s*\[\s*require\.resolve\(\s*['"][^'"]*backend\/database/);
  const iDbDir = src.search(/process\.env\.DB_DIR\s*=/);
  const iMemoria = src.search(/['"]:memory:['"]/);
  const iTemp = src.search(/os\.tmpdir\s*\(|mkdtempSync\s*\(/);
  const iEager = indicePrimeiroRequire(src, RISCO_EAGER);
  const iLazy = indicePrimeiroRequire(src, RISCO_LAZY);
  const iRisco = (iEager >= 0 && iLazy >= 0)
    ? Math.min(iEager, iLazy)
    : (iEager >= 0 ? iEager : iLazy);

  const isolamentoAntes = (pos) => pos < 0 || (
    (iHelper >= 0 && iHelper < pos)
    || (iStub >= 0 && iStub < pos)
    || (iDbDir >= 0 && iDbDir < pos)
    || (iMemoria >= 0 && iMemoria < pos)
  );

  const usaMemoriaOuTemp = iMemoria >= 0 || iTemp >= 0 || iDbDir >= 0;

  if (iRisco < 0) {
    return {
      arquivo: rel,
      classe: 'SEM ACESSO AO BANCO',
      evidencia: 'Sem require de database.js, DistDFe, sqlite3, repositórios ou serviços de persistência.',
      usaMemoriaOuTemp
    };
  }

  if (iHelper >= 0 && iHelper < iRisco) {
    return {
      arquivo: rel,
      classe: 'ISOLADA COMPROVADA',
      evidencia: `isolarBancoTeste() na posição ${iHelper}, antes do primeiro require de risco (${iRisco}).`,
      usaMemoriaOuTemp
    };
  }

  if ((iStub >= 0 && iStub < iRisco) || (iMemoria >= 0 && iMemoria < iRisco) || (iDbDir >= 0 && iDbDir < iRisco)) {
    return {
      arquivo: rel,
      classe: 'MEMORIA_OU_TEMP',
      evidencia: `Usa :memory:, stub de database.js ou DB_DIR temporário antes do risco (${iRisco}), sem isolarBancoTeste().`,
      usaMemoriaOuTemp: true
    };
  }

  if (iEager >= 0 && !isolamentoAntes(iEager)) {
    return {
      arquivo: rel,
      classe: 'BLOQUEADA ATÉ ISOLAMENTO',
      evidencia: `Require eager de database/DistDFe/auditoria/sqlite3/core na posição ${iEager} sem isolamento prévio.`,
      usaMemoriaOuTemp
    };
  }

  if (iLazy >= 0 && !isolamentoAntes(iLazy)) {
    return {
      arquivo: rel,
      classe: 'BLOQUEADA ATÉ ISOLAMENTO',
      evidencia: `Require de repositório/serviço com persistência na posição ${iLazy} sem isolamento prévio.`,
      usaMemoriaOuTemp
    };
  }

  return {
    arquivo: rel,
    classe: 'NÃO VERIFICADA',
    evidencia: 'Padrão de require não classificado com segurança.',
    usaMemoriaOuTemp
  };
}

function listarTestes(dir) {
  const saida = [];
  if (!dir || !fs.existsSync(dir)) return saida;
  for (const nome of fs.readdirSync(dir)) {
    const cheio = path.join(dir, nome);
    const st = fs.statSync(cheio);
    if (st.isDirectory()) {
      if (nome === 'helpers') continue;
      saida.push(...listarTestes(cheio));
      continue;
    }
    if (nome.endsWith('.test.js')) saida.push(cheio);
  }
  return saida.sort();
}

function classificarArquivos(arquivos) {
  return arquivos.map((cheio) => {
    const rel = path.relative(REPO_ROOT, cheio).replace(/\\/g, '/');
    return classificarFonte(fs.readFileSync(cheio, 'utf8'), rel);
  });
}

function classificarTodos(dirs = [DIR_CENTRAL]) {
  const arquivos = dirs.flatMap((dir) => listarTestes(dir));
  return classificarArquivos(arquivos);
}

function classificarEscopoP011() {
  return classificarTodos([DIR_CENTRAL, DIR_FISCAL]);
}

module.exports = {
  classificarFonte,
  classificarTodos,
  classificarEscopoP011,
  listarTestes,
  DIR_CENTRAL,
  DIR_FISCAL,
  RISCO_EAGER,
  RISCO_LAZY
};
