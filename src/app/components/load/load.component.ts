import { Component, ViewEncapsulation, HostBinding, NgZone, OnDestroy } from '@angular/core';
import { AuthenticationService } from '../../services/authentication.service';
import { Router } from '@angular/router';
import { ApplicationStateService } from '../../services/application-state.service';
import * as signalR from '@aspnet/signalr';
import { ApiService } from '../../services/api.service';
import { delay, retryWhen, tap } from 'rxjs/operators';
import { Logger } from '../../services/logger.service';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { NodeStatus } from '@models/node-status';
import { ElectronService } from 'ngx-electron';

export interface ListItem {
    name: string;
    id: string;
}

@Component({
    selector: 'app-load',
    templateUrl: './load.component.html',
    styleUrls: ['./load.component.scss'],
    encapsulation: ViewEncapsulation.None,
})
export class LoadComponent implements OnDestroy {
    @HostBinding('class.load') hostClass = true;

    selectedMode: ListItem;
    selectedNetwork: ListItem;
    loading: boolean;
    hasWallet = false;
    modes: ListItem[] = [];
    networks: ListItem[] = [];
    remember: boolean;
    connection: signalR.HubConnection;
    delayed = false;
    apiSubscription: any;

    private subscription: Subscription;
    private statusIntervalSubscription: Subscription;
    private readonly TryDelayMilliseconds = 3000;
    private readonly MaxRetryCount = 50;
    loadingFailed = false;
    public apiConnected = false;

    constructor(
        private http: HttpClient,
        private authService: AuthenticationService,
        private electronService: ElectronService,
        private router: Router,
        private log: Logger,
        private zone: NgZone,
        private apiService: ApiService,
        public appState: ApplicationStateService) {

        this.modes = [
            // { id: 'simple', name: 'Mobile' },
            // { id: 'light', name: 'Light' },
            { id: 'full', name: 'Full' },
            // { id: 'pos', name: 'Point-of-Sale (POS)' },
            // { id: 'readonly', name: 'Read-only' }
        ];

        this.networks = [
            // { id: 'main', name: 'Main' },
            { id: 'citymain', name: 'City Chain' },
            { id: 'citytest', name: 'City Chain (Test)' },
            // { id: 'stratistest', name: 'Stratis (Test)' },
            // { id: 'stratismain', name: 'Stratis' },
            // { id: 'regtest', name: 'RegTest' }
        ];

        this.selectedMode = this.modes.find(mode => mode.id === this.appState.mode);
        this.selectedNetwork = this.networks.find(network => network.id === this.appState.network);
        this.remember = true;

        const existingMode = localStorage.getItem('Network:Mode');

        // this.log.info(`Mode: ${this.selectedMode}, Network: ${this.selectedNetwork}.`);
        this.log.info('Mode:', this.selectedMode);
        this.log.info('Network:', this.selectedNetwork);

        // If user has choosen to remember mode, we'll redirect directly to login, when connected.
        if (existingMode != null) {
            this.initialize();
        }
    }

    initialize() {
        this.apiService.initialize();

        if (this.appState.mode === 'full') {
            this.loading = true;
            this.appState.connected = false;
            this.fullNodeConnect();
        }
    }

    launch() {
        if (this.remember) {
            localStorage.setItem('Network:Mode', this.selectedMode.id);
            localStorage.setItem('Network:Network', this.selectedNetwork.id);
        } else {
            localStorage.removeItem('Network:Mode');
            localStorage.removeItem('Network:Network');
        }

        this.appState.mode = this.selectedMode.id;
        this.appState.network = this.selectedNetwork.id;

        this.initialize();
    }

    fullNodeConnect() {
        // Do we need to keep a pointer to this timeout and remove it, or does the zone handle that?
        this.zone.run(() => {
            setTimeout(() => {
                this.delayed = true;
            }, 30000); // 30000 Make sure it is fairly high, we don't want users to immediatly perform advanced reset options when they don't need to.
        });

        this.tryStart();
    }

    // Attempts to initialise the wallet by contacting the daemon.  Will try to do this MaxRetryCount times.
    private tryStart() {
        let retry = 0;
        const stream$ = this.apiService.getNodeStatus().pipe(
            retryWhen(errors =>
                errors.pipe(delay(this.TryDelayMilliseconds)).pipe(
                    tap(errorStatus => {
                        if (retry++ === this.MaxRetryCount) {
                            throw errorStatus;
                        }
                        this.log.info(`Retrying ${retry}...`);
                    })
                )
            )
        );

        this.subscription = stream$.subscribe(
            (data: NodeStatus) => {
                this.apiConnected = true;
                this.statusIntervalSubscription = this.apiService.getNodeStatusInterval()
                    .subscribe(
                        response => {
                            const statusResponse = response.featuresData.filter(x => x.namespace === 'Stratis.Bitcoin.Base.BaseFeature');
                            if (statusResponse.length > 0 && statusResponse[0].state === 'Initialized') {
                                this.statusIntervalSubscription.unsubscribe();
                                this.start();
                            }
                        }
                    );
            }, (error: any) => {
                this.log.info('Failed to start wallet');
                this.loading = false;
                this.loadingFailed = true;
            }
        );
    }

    start() {
        // this.simpleWalletConnect();

        // We have successful connection with daemon, make sure we inform the main process of |.
        this.electronService.ipcRenderer.send('daemon-started');

        this.loading = false;
        this.appState.connected = true;
        this.router.navigateByUrl('/login');
    }

    ngOnDestroy() {
        this.unsubscribe();
    }

    unsubscribe() {
        if (this.apiSubscription) {
            this.apiSubscription.unsubscribe();
        }
    }

    cancel() {
        this.unsubscribe();

        this.appState.connected = false;
        this.loading = false;
        this.delayed = false;
        this.appState.mode = null;
    }

    simpleWalletConnect() {
        this.connection = new signalR.HubConnectionBuilder()
            .withUrl('http://localhost:4337/node')
            .build();

        this.connection.on('BlockConnected', (block) => {
            console.log('BlockConnected:' + block);
        });

        this.connection.on('TransactionReceived', (trx) => {
            console.log('TransactionReceived:' + trx);
        });

        this.connection.on('txs', (transactions) => {
            console.log(transactions);
            // TODO: Update a bitcore-lib fork to add support for Stratis/City Chain.
            // var tx1 = transactions[0];
            // var tx = bitcoin.Transaction.fromHex(tx1.value.hex);
        });

        const self = this;
        // Transport fallback functionality is now built into start.
        this.connection.start()
            .then(() => {
                console.log('connection started');
                self.connection.send('Subscribe', { events: ['TransactionReceived', 'BlockConnected'] });
            })
            .catch(error => {
                console.error(error.message);
            });
    }
}
