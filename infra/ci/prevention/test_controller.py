"""Offline checks of the actual Helm slice and controller failure accounting."""
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import yaml
import cluster as c
import lifecycle as life


class ControllerChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        c.WORK.mkdir(parents=True, exist_ok=True)
        c.EVIDENCE.mkdir(exist_ok=True)

    def test_exact_migration_templates_render_install_and_upgrade(self):
        for name, source, image in [
            ('current', c.ROOT, 'fixture@sha256:' + 'a' * 64),
            ('previous72', c.ROOT / 'prior72', c.PINS['alpha72']['image']),
            ('previous69', c.ROOT / 'prior69', c.PINS['alpha69']['image']),
        ]:
            directory = life.chart(source, name, image)
            for upgrade in (False, True):
                args = ['helm', 'template', 'fixture', str(directory), '-n', 'fixture-test']
                if upgrade:
                    args.append('--is-upgrade')
                rendered = subprocess.run(args, check=True, capture_output=True, text=True).stdout
                docs = [d for d in yaml.safe_load_all(rendered) if d]
                job = next(d for d in docs if d['kind'] == 'Job')
                spec = job['spec']['template']['spec']
                migrate = spec['containers'][0]
                self.assertEqual(migrate['command'], ['node', 'services/codeops-control-gateway/dist/session-migrate-main.js'])
                self.assertEqual(migrate['image'], image)
                self.assertEqual(spec['automountServiceAccountToken'], upgrade)
                if name == 'current':
                    env = {e['name']: e.get('value') for e in migrate['env']}
                    self.assertIn('CODEOPS_APPLICATION_DATABASE_URL_FILE', env)
                    hooks = {d['metadata']['name']: d['metadata'].get('annotations', {}) for d in docs if d['kind'] == 'Secret'}
                    self.assertEqual(hooks['codeops-migration-secrets']['helm.sh/hook-weight'], '-15')
                    self.assertEqual(hooks['codeops-application-database']['helm.sh/hook-weight'], '-14')
                    self.assertNotIn('helm.sh/hook', hooks['codeops-session-secrets'])
                deployment = next(d for d in docs if d['kind'] == 'Deployment')
                self.assertIn('readinessProbe', deployment['spec']['template']['spec']['containers'][0])

    def test_cluster_dns_does_not_keep_an_upstream_escape(self):
        for spaces in (4, 8):
            pad = ' ' * spaces
            raw = '.:53 {\n' + pad + 'kubernetes cluster.local\n' + pad + 'forward . /etc/resolv.conf {\n' + pad + '  max_concurrent 1000\n' + pad + '}\n}\n'
            self.assertNotIn('forward', c.cluster_only_dns(raw))
        with self.assertRaises(RuntimeError):
            c.cluster_only_dns('.:53 {\n forward . 8.8.8.8\n}\n')

    def test_restore_refuses_replaced_writer_before_patch(self):
        with patch.object(life, 'get', return_value={'metadata': {'uid': 'replacement'}, 'spec': {'replicas': 0}}), \
             patch.object(c, 'kubectl') as api:
            with self.assertRaisesRegex(AssertionError, 'identity/state'):
                life.restore('fixture', 'original')
            api.assert_not_called()

    def test_failed_helm_is_never_counted_as_success(self):
        with patch.object(life, 'diagnose'), patch.object(c, 'command', return_value=subprocess.CompletedProcess([], 1, '', 'fixture failure')):
            with self.assertRaisesRegex(AssertionError, 'outcome mismatch'):
                life.helm('fixture', Path('/fixture'))

    def test_successful_helm_is_never_counted_as_expected_failure(self):
        with patch.object(life, 'diagnose'), patch.object(c, 'command', return_value=subprocess.CompletedProcess([], 0, '', '')):
            with self.assertRaisesRegex(AssertionError, 'outcome mismatch'):
                life.helm('fixture', Path('/fixture'), success=False)


if __name__ == '__main__':
    unittest.main()
