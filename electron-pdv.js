const { iniciarAplicacaoElectron } = require('./electron-common');

process.env.CDS_APP_MODULO = process.env.CDS_APP_MODULO || 'pdv';

// CDS-PDV-RECOMPOSICAO-FISCAL-MISTA-HARDENING-01 — configuração determinística do PDV.
// Não herda =0 do Windows; não liga reescrita no emissor; não liga flags de teste.
process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL = '1';
delete process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO;
delete process.env.CDS_RECOMPOSICAO_DIAGNOSTICO;

iniciarAplicacaoElectron({
  tituloJanela: 'CDS Sistemas - PDV',
  modulo: 'pdv'
});
